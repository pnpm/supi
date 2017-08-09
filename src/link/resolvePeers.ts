import {
  Resolution,
  PackageContentInfo,
  pkgIdToFilename,
} from 'package-store'
import {Dependencies, Package} from '../types'
import R = require('ramda')
import semver = require('semver')
import logger from 'pnpm-logger'
import path = require('path')
import {InstalledPackage} from '../install/installMultiple'
import {TreeNode, TreeNodeMap} from '../api/install'
import Rx = require('@reactivex/rxjs')

type DependencyTreeNodeContainer = {
  nodeId: string,
  node: _DependencyTreeNode,
  depth: number,
  isRepeated: boolean,
  isCircular: boolean,
}

export type DependencyTreeNode = {
  name: string,
  // at this point the version is really needed only for logging
  version: string,
  hasBundledDependencies: boolean,
  hasBins: boolean,
  path: string,
  modules: string,
  fetchingFiles: Promise<PackageContentInfo>,
  resolution: Resolution,
  hardlinkedLocation: string,
  children$: Rx.Observable<string>,
  // an independent package is a package that
  // has neither regular nor peer dependencies
  independent: boolean,
  optionalDependencies: Set<string>,
  depth: number,
  absolutePath: string,
  dev: boolean,
  optional: boolean,
  pkgId: string,
  installable: boolean,
}

type _DependencyTreeNode = {
  name: string,
  // at this point the version is really needed only for logging
  version: string,
  hasBundledDependencies: boolean,
  hasBins: boolean,
  path: string,
  modules: string,
  fetchingFiles: Promise<PackageContentInfo>,
  resolution: Resolution,
  hardlinkedLocation: string,
  children$: Rx.Observable<string>,
  peerNodeIds: Set<string>,
  // an independent package is a package that
  // has neither regular nor peer dependencies
  independent: boolean,
  optionalDependencies: Set<string>,
  depth: number,
  absolutePath: string,
  dev: boolean,
  optional: boolean,
  pkgId: string,
  installable: boolean,
}

type _DependencyTreeNodeMap = {
  [nodeId: string]: _DependencyTreeNode
}

export type DependencyTreeNodeMap = {
  // a node ID is the join of the package's keypath with a colon
  // E.g., a subdeps node ID which parent is `foo` will be
  // registry.npmjs.org/foo/1.0.0:registry.npmjs.org/bar/1.0.0
  [nodeId: string]: DependencyTreeNode
}

export default function (
  tree: TreeNodeMap,
  rootNodeIds: string[],
  topPkgIds: string[],
  // only the top dependencies that were already installed
  // to avoid warnings about unresolved peer dependencies
  topParents: {name: string, version: string}[],
  independentLeaves: boolean,
  nodeModules: string,
  opts: {
    nonDevPackageIds: Set<string>,
    nonOptionalPackageIds: Set<string>,
  }
): {
  resolvedTree$: Rx.Observable<DependencyTreeNode>,
  rootNode$: Rx.Observable<DependencyTreeNode>,
} {
  const pkgsByName = R.fromPairs(
    topParents.map((parent: {name: string, version: string}): R.KeyValuePair<string, ParentRef> => [
      parent.name,
      {
        version: parent.version,
        depth: 0
      }
    ])
  )

  const result = resolvePeersOfChildren(Rx.Observable.of(new Set(rootNodeIds)), pkgsByName, {
    tree,
    resolvedTree: {},
    independentLeaves,
    nodeModules,
    nonDevPackageIds: opts.nonDevPackageIds,
    nonOptionalPackageIds: opts.nonOptionalPackageIds,
  })

  return {
    resolvedTree$: result.resolvedTree$
      .mergeMap(container => {
        if (container.isRepeated) {
          return Rx.Observable.empty<DependencyTreeNodeContainer>()
        }
        if (container.isCircular) {
          return result.resolvedTree$
            .skipWhile(nextContainer => nextContainer.nodeId !== container.nodeId)
            .take(1)
            .mergeMap(nextContainer => {
              if (nextContainer.node.absolutePath === container.node.absolutePath) {
                return Rx.Observable.of(nextContainer)
              }
              return Rx.Observable.from([nextContainer, container])
            })
        }
        return Rx.Observable.of(container)
      })
      .map(container => Object.assign(container.node, {
        children$: container.node.children$.merge(container.node.peerNodeIds.size
            ? result.resolvedTree$
              .filter(childNode => container.node.peerNodeIds.has(childNode.nodeId))
              .take(container.node.peerNodeIds.size)
              .map(childNode => childNode.node.absolutePath)
            : Rx.Observable.empty()
          ),
      }))
      .distinct(v => v.absolutePath) /// this is bad.....
      .shareReplay(Infinity),
    rootNode$: result.resolvedTree$.filter(node => node.depth === 0).map(container => container.node),
  }
}

function resolvePeersOfNode (
  nodeId: string,
  parentPkgs: ParentRefs,
  ctx: {
    tree: TreeNodeMap,
    resolvedTree: _DependencyTreeNodeMap,
    independentLeaves: boolean,
    nodeModules: string,
    nonDevPackageIds: Set<string>,
    nonOptionalPackageIds: Set<string>,
  }
): {
  resolvedTree$: Rx.Observable<DependencyTreeNodeContainer>,
  allResolvedPeers$: Rx.Observable<string>
} {
  const node = ctx.tree[nodeId]

  const children$ = node.children$
    .reduce((acc: string[], child: string) => {
      acc.push(child)
      return acc
    }, [])

  const childrenSet$ = children$.map(children => new Set(children))

  const result = resolvePeersOfChildren(childrenSet$, parentPkgs, ctx)

  const unknownResolvedPeersOfChildren$ = result.allResolvedPeers$
    .filter(unresolvedPeerNodeId => unresolvedPeerNodeId !== nodeId)

  const resolvedPeers$ = (
    R.isEmpty(node.pkg.peerDependencies)
      ? Rx.Observable.empty() as Rx.Observable<string>
      : children$.mergeMap(children => resolvePeers(node, Object.assign({}, parentPkgs,
        toPkgByName(R.props<TreeNode>(children, ctx.tree))
      ), ctx.tree))
  )

  const allResolvedPeers$ = unknownResolvedPeersOfChildren$.merge(resolvedPeers$)

  const resolvedNode$ = Rx.Observable.combineLatest(
    allResolvedPeers$
      .reduce((acc: Set<string>, peer: string) => {
        acc.add(peer)
        return acc
      }, new Set()
    ),
    childrenSet$,
    resolvedPeers$.reduce((acc: Set<string>, peer: string) => {
      acc.add(peer)
      return acc
    }, new Set<string>()),
    (allResolvedPeers, childrenSet, resolvedPeers) => {
      let modules: string
      let absolutePath: string
      const localLocation = path.join(ctx.nodeModules, `.${pkgIdToFilename(node.pkg.id)}`)
      if (!allResolvedPeers.size) {
        modules = path.join(localLocation, 'node_modules')
        absolutePath = node.pkg.id
      } else {
        const peersFolder = createPeersFolderName(R.props<TreeNode>(Array.from(allResolvedPeers), ctx.tree).map(node => node.pkg))
        modules = path.join(localLocation, peersFolder, 'node_modules')
        absolutePath = `${node.pkg.id}/${peersFolder}`
      }

      if (!ctx.resolvedTree[absolutePath] || ctx.resolvedTree[absolutePath].depth > node.depth) {
        const independent = ctx.independentLeaves && !childrenSet.size && R.isEmpty(node.pkg.peerDependencies)
        const pathToUnpacked = path.join(node.pkg.path, 'node_modules', node.pkg.name)
        const hardlinkedLocation = !independent
          ? path.join(modules, node.pkg.name)
          : pathToUnpacked
        ctx.resolvedTree[absolutePath] = {
          name: node.pkg.name,
          version: node.pkg.version,
          hasBundledDependencies: node.pkg.hasBundledDependencies,
          hasBins: node.pkg.hasBins,
          fetchingFiles: node.pkg.fetchingFiles,
          resolution: node.pkg.resolution,
          path: pathToUnpacked,
          modules,
          hardlinkedLocation,
          independent,
          optionalDependencies: node.pkg.optionalDependencies,
          children$: result.resolvedTree$
            .filter(childNode => childNode.depth === node.depth + 1)
            .take(childrenSet.size)
            .map(childNode => childNode.node.absolutePath),
          peerNodeIds: difference(resolvedPeers, childrenSet),
          depth: node.depth,
          absolutePath,
          dev: !ctx.nonDevPackageIds.has(node.pkg.id),
          optional: !ctx.nonOptionalPackageIds.has(node.pkg.id),
          pkgId: node.pkg.id,
          installable: node.installable,
        }
        return {
          depth: node.depth,
          node: ctx.resolvedTree[absolutePath],
          nodeId: node.nodeId,
          isRepeated: false,
          isCircular: node.isCircular,
        }
      }
      return {
        depth: node.depth,
        node: ctx.resolvedTree[absolutePath],
        nodeId: node.nodeId,
        isRepeated: true,
        isCircular: node.isCircular,
      }
  })

  return {
    allResolvedPeers$: allResolvedPeers$,
    resolvedTree$: resolvedNode$.merge(result.resolvedTree$),
  }
}

function addMany<T>(a: Set<T>, b: Set<T>) {
  for (const el of Array.from(b)) {
    a.add(el)
  }
  return a
}

function union<T>(a: Set<T>, b: Set<T>) {
  return new Set(Array.from(a).concat(Array.from(b)))
}

function difference<T>(a: Set<T>, b: Set<T>) {
  return new Set(Array.from(a).filter(el => !b.has(el)))
}

function resolvePeersOfChildren (
  children$: Rx.Observable<Set<string>>,
  parentParentPkgs: ParentRefs,
  ctx: {
    tree: {[nodeId: string]: TreeNode},
    resolvedTree: _DependencyTreeNodeMap,
    independentLeaves: boolean,
    nodeModules: string,
    nonDevPackageIds: Set<string>,
    nonOptionalPackageIds: Set<string>,
  }
): {
  resolvedTree$: Rx.Observable<DependencyTreeNodeContainer>,
  allResolvedPeers$: Rx.Observable<string>
} {
  const result = children$.mergeMap(children => {
    const childrenArray = Array.from(children)
    const parentPkgs = Object.assign({}, parentParentPkgs,
      toPkgByName(R.props<TreeNode>(childrenArray, ctx.tree))
    )

    return Rx.Observable.from(childrenArray)
      .map(child => resolvePeersOfNode(child, parentPkgs, ctx))
      .map(result => ({
        allResolvedPeers$: result.allResolvedPeers$.filter(resolvedPeer => !children.has(resolvedPeer)),
        resolvedTree$: result.resolvedTree$,
      }))
  })

  return {
    allResolvedPeers$: result.mergeMap(result => result.allResolvedPeers$),
    resolvedTree$: result.mergeMap(result => result.resolvedTree$).shareReplay(Infinity),
  }
}

function resolvePeers (
  node: TreeNode,
  parentPkgs: ParentRefs,
  tree: TreeNodeMap
): Rx.Observable<string> {
  return Rx.Observable.from(R.keys(node.pkg.peerDependencies))
    .mergeMap(peerName => {
      const peerVersionRange = node.pkg.peerDependencies[peerName]

      const resolved = parentPkgs[peerName]

      if (!resolved || resolved.nodeId && !tree[resolved.nodeId].installable) {
        logger.warn(`${node.pkg.id} requires a peer of ${peerName}@${peerVersionRange} but none was installed.`)
        return Rx.Observable.empty()
      }

      if (!semver.satisfies(resolved.version, peerVersionRange)) {
        logger.warn(`${node.pkg.id} requires a peer of ${peerName}@${peerVersionRange} but version ${resolved.version} was installed.`)
      }

      if (resolved.depth === 0 || resolved.depth === node.depth + 1) {
        // if the resolved package is a top dependency
        // or the peer dependency is resolved from a regular dependency of the package
        // then there is no need to link it in
        return Rx.Observable.empty()
      }

      if (resolved && resolved.nodeId) return Rx.Observable.of(resolved.nodeId)

      return Rx.Observable.empty()
    })
}

type ParentRefs = {
  [name: string]: ParentRef
}

type ParentRef = {
  version: string,
  depth: number,
  // this is null only for already installed top dependencies
  nodeId?: string,
}

function toPkgByName (nodes: TreeNode[]): ParentRefs {
  const pkgsByName: ParentRefs = {}
  for (const node of nodes) {
    pkgsByName[node.pkg.name] = {
      version: node.pkg.version,
      nodeId: node.nodeId,
      depth: node.depth,
    }
  }
  return pkgsByName
}

function createPeersFolderName(peers: InstalledPackage[]) {
  return peers.map(peer => `${peer.name.replace('/', '!')}@${peer.version}`).sort().join('+')
}
