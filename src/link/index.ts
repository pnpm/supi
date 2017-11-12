import fs = require('mz/fs')
import path = require('path')
import symlinkDir = require('symlink-dir')
import exists = require('path-exists')
import logger from '@pnpm/logger'
import R = require('ramda')
import pLimit = require('p-limit')
import {InstalledPackage} from '../install/installMultiple'
import {InstalledPackages, TreeNode} from '../api/install'
import linkBins, {linkPkgBins} from './linkBins'
import {PackageJson, Dependencies} from '@pnpm/types'
import {
  Resolution,
  PackageContentInfo,
  Store,
  DirectoryResolution,
} from 'package-store'
import resolvePeers, {ResolvedNode, Map} from './resolvePeers'
import logStatus from '../logging/logInstallStatus'
import updateShrinkwrap, {DependencyShrinkwrapContainer} from './updateShrinkwrap'
import * as dp from 'dependency-path'
import {
  Shrinkwrap,
  DependencyShrinkwrap,
  prune as pruneShrinkwrap,
} from 'pnpm-shrinkwrap'
import removeOrphanPkgs from '../api/removeOrphanPkgs'
import linkIndexedDir from '../fs/linkIndexedDir'
import ncpCB = require('ncp')
import thenify = require('thenify')
import Rx = require('@reactivex/rxjs/dist/package/Rx')
import {syncShrinkwrapWithManifest} from '../fs/shrinkwrap'
import {
  rootLogger,
  stageLogger,
} from '../loggers'

const ncp = thenify(ncpCB)

// Important note! Filesystem operations are faster when not too aggressive
// removing this concurrency limitation makes the overally linking time a lot slower
const limitLinking = pLimit(16)

export default async function (
  rootNodeId$: Rx.Observable<string>,
  tree: {[nodeId: string]: TreeNode},
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    bin: string,
    topParent$: Rx.Observable<{name: string, version: string}>,
    wantedShrinkwrap: Shrinkwrap,
    currentShrinkwrap: Shrinkwrap,
    makePartialCurrentShrinkwrap: boolean,
    production: boolean,
    development: boolean,
    optional: boolean,
    root: string,
    storePath: string,
    storeIndex: Store,
    skipped: Set<string>,
    pkg: PackageJson,
    independentLeaves: boolean,
    nonOptionalPackageIds: Set<string>,
    localPackages: {
      optional: boolean,
      dev: boolean,
      resolution: DirectoryResolution,
      absolutePath: string,
      version: string,
      name: string,
      specRaw: string,
    }[],
    // This is only needed till shrinkwrap v4
    updateShrinkwrapMinorVersion: boolean,
    outdatedPkgs: {[pkgId: string]: string},
  }
): Promise<{
  resolvedNodesMap: Map<ResolvedNode>,
  wantedShrinkwrap: Shrinkwrap,
  currentShrinkwrap: Shrinkwrap,
  updatedPkgsAbsolutePaths: string[],
}> {
  // TODO: decide what kind of logging should be here.
  // The `Creating dependency tree` is not good to report in all cases as
  // sometimes node_modules is alread up-to-date
  // logger.info(`Creating dependency tree`)
  const resolvePeersResult = resolvePeers(
    tree,
    rootNodeId$,
    opts.topParent$,
    opts.independentLeaves,
    opts.baseNodeModules, {
      nonOptionalPackageIds: opts.nonOptionalPackageIds,
    })

  const resolvedNode$ = resolvePeersResult.resolvedNode$
  const rootResolvedNode$ = resolvePeersResult.rootResolvedNode$

  resolvedNode$.subscribe({
    error: () => {},
    next: () => {},
    complete: () => stageLogger.debug('resolution_done'),
  })
  const depShr$ = updateShrinkwrap(resolvedNode$, opts.wantedShrinkwrap, opts.pkg)

  const filterOpts = {
    noProd: !opts.production,
    noDev: !opts.development,
    noOptional: !opts.optional,
    skipped: opts.skipped,
  }

  const updatedPkgsAbsolutePaths$ = linkNewPackages(
    filterShrinkwrap(opts.currentShrinkwrap, filterOpts),
    depShr$,
    opts,
    filterOpts,
    opts.wantedShrinkwrap.registry
  )

  const updatedPkgsAbsolutePaths = await updatedPkgsAbsolutePaths$
    .toArray()
    .toPromise()

  const shrPackages = opts.wantedShrinkwrap.packages || {}
  await depShr$.forEach(depShr => {
    shrPackages[depShr.dependencyPath] = depShr.snapshot
  })
  opts.wantedShrinkwrap.packages = shrPackages

  const rootResolvedNodes = await rootResolvedNode$
    .toArray()
    .toPromise()

  const pkgsToSave = (rootResolvedNodes as {
    resolution: Resolution,
    absolutePath: string,
    version: string,
    name: string,
    dev: boolean,
    optional: boolean,
  }[]).concat(opts.localPackages)
  syncShrinkwrapWithManifest(opts.wantedShrinkwrap, opts.pkg,
    pkgsToSave.map(resolvedNode => ({
      optional: resolvedNode.optional,
      dev: resolvedNode.dev,
      absolutePath: resolvedNode.absolutePath,
      name: resolvedNode.name,
      resolution: resolvedNode.resolution,
    })))

  const newShr = pruneShrinkwrap(opts.wantedShrinkwrap, opts.pkg)

  const waitq: Promise<{} | void>[] = []
  waitq.push(removeOrphanPkgs({
    oldShrinkwrap: opts.currentShrinkwrap,
    newShrinkwrap: newShr,
    prefix: opts.root,
    store: opts.storePath,
    storeIndex: opts.storeIndex,
    bin: opts.bin,
  }))

  let wantedRootResolvedNode$ = rootResolvedNode$.filter(dep => !opts.skipped.has(dep.pkgId))
  if (!opts.production) {
    wantedRootResolvedNode$ = wantedRootResolvedNode$.filter(dep => dep.dev !== false || dep.optional)
  }
  if (!opts.development) {
    wantedRootResolvedNode$ = wantedRootResolvedNode$.filter(dep => dep.dev !== true)
  }
  if (!opts.optional) {
    wantedRootResolvedNode$ = wantedRootResolvedNode$.filter(dep => !dep.optional)
  }

  waitq.push(
    wantedRootResolvedNode$.mergeMap(resolvedNode => {
      return Rx.Observable.fromPromise(symlinkDependencyTo(resolvedNode, opts.baseNodeModules))
        .map(symlinkingResult => {
          const isDev = opts.pkg.devDependencies && opts.pkg.devDependencies[resolvedNode.name]
          const isOptional = opts.pkg.optionalDependencies && opts.pkg.optionalDependencies[resolvedNode.name]
          if (!symlinkingResult.reused) {
            rootLogger.info({
              added: {
                id: resolvedNode.pkgId,
                name: resolvedNode.name,
                version: resolvedNode.version,
                dependencyType: isDev && 'dev' || isOptional && 'optional' || 'prod',
                latest: opts.outdatedPkgs[resolvedNode.pkgId],
              },
            })
          }
          logStatus({
            status: 'installed',
            pkgId: resolvedNode.pkgId,
          })
        })
    })
    .toPromise()
  )

  waitq.push(
    resolvedNode$
      .map(resolvedNode => [resolvedNode.absolutePath, resolvedNode])
      .toArray()
      .map(R.fromPairs)
      .toPromise()
  )

  const resolvedNodesMap = (await Promise.all(waitq))[2] as Map<ResolvedNode>

  await linkBins(opts.baseNodeModules, opts.bin)

  if (opts.updateShrinkwrapMinorVersion) {
    // Setting `shrinkwrapMinorVersion` is a temporary solution to
    // have new backward-compatible versions of `shrinkwrap.yaml`
    // w/o changing `shrinkwrapVersion`. From version 4, the
    // `shrinkwrapVersion` field allows numbers like 4.1
    newShr.shrinkwrapMinorVersion = 2
  }
  let currentShrinkwrap: Shrinkwrap
  if (opts.makePartialCurrentShrinkwrap) {
    const packages = opts.currentShrinkwrap.packages || {}
    if (newShr.packages) {
      for (const shortId in newShr.packages) {
        const resolvedId = dp.resolve(newShr.registry, shortId)
        if (resolvedNodesMap[resolvedId]) {
          packages[shortId] = newShr.packages[shortId]
        }
      }
    }
    currentShrinkwrap = Object.assign({}, newShr, {
      packages,
    })
  } else if (opts.production && opts.development && opts.optional) {
    currentShrinkwrap = newShr
  } else {
    currentShrinkwrap = filterShrinkwrap(newShr, filterOpts)
  }

  return {
    resolvedNodesMap,
    wantedShrinkwrap: newShr,
    currentShrinkwrap,
    updatedPkgsAbsolutePaths,
  }
}

function filterShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    noProd: boolean,
    noDev: boolean,
    noOptional: boolean,
    skipped: Set<string>,
  }
): Shrinkwrap {
  let pairs = R.toPairs<string, DependencyShrinkwrap>(shr.packages || {})
    .filter(pair => !opts.skipped.has(pair[1].id || dp.resolve(shr.registry, pair[0])))
  if (opts.noProd) {
    pairs = pairs.filter(pair => pair[1].dev !== false || pair[1].optional)
  }
  if (opts.noDev) {
    pairs = pairs.filter(pair => pair[1].dev !== true)
  }
  if (opts.noOptional) {
    pairs = pairs.filter(pair => !pair[1].optional)
  }
  return {
    shrinkwrapVersion: shr.shrinkwrapVersion,
    registry: shr.registry,
    specifiers: shr.specifiers,
    packages: R.fromPairs(pairs),
    dependencies: opts.noProd ? {} : shr.dependencies || {},
    devDependencies: opts.noDev ? {} : shr.devDependencies || {},
    optionalDependencies: opts.noOptional ? {} : shr.optionalDependencies || {},
  } as Shrinkwrap
}

function linkNewPackages (
  currentShrinkwrap: Shrinkwrap,
  resolvedPkg$: Rx.Observable<DependencyShrinkwrapContainer>,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    optional: boolean,
  },
  filterOpts: {
    noDev: boolean,
    noOptional: boolean,
    skipped: Set<string>,
  },
  registry: string
): Rx.Observable<string> {
  let copy = false
  const prevPackages = currentShrinkwrap.packages || {}
  const outOfDateResolvedPkg$ = resolvedPkg$
    .filter(resolvedPkg => {
      if (filterOpts.noDev && resolvedPkg.node.dev) return false
      if (filterOpts.noOptional && resolvedPkg.node.optional) return false
      if (filterOpts.skipped.has(resolvedPkg.node.pkgId)) return false
      if (!resolvedPkg.node.installable) return false

      // TODO: what if the registries differ?
      if (opts.force || !prevPackages[resolvedPkg.dependencyPath]) {
        return true
      }

      // add subdependencies that have been updated
      // TODO: no need to relink everything. Can be relinked only what was changed
      return !R.equals(prevPackages[resolvedPkg.dependencyPath].dependencies, resolvedPkg.snapshot.dependencies) ||
        !R.equals(prevPackages[resolvedPkg.dependencyPath].optionalDependencies, resolvedPkg.snapshot.optionalDependencies)
    })
    .shareReplay(Infinity)

  const pkgWithLinkedModules$ = outOfDateResolvedPkg$
    .mergeMap(resolvedPkg => {
      const wantedDependencies = resolvedPkg.dependencies.concat(opts.optional ? resolvedPkg.optionalDependencies : [])
      return linkModules(resolvedPkg.node, wantedDependencies)
        .mapTo({
          resolvedPkg,
          dependenciesWithBins: wantedDependencies.filter(pkg => pkg.hasBins),
        })
    })
    .shareReplay(Infinity)

  const pkgWithLinkedContent$ = outOfDateResolvedPkg$
    .mergeMap(resolvedPkg => {
      const linkPkgContent$ = copy
        ? Rx.Observable.fromPromise(linkPkgToAbsPath(copyPkg, resolvedPkg.node, opts))
        : Rx.Observable.fromPromise(linkPkgToAbsPath(linkPkg, resolvedPkg.node, opts))
          .catch(err => {
            if (!err.message.startsWith('EXDEV: cross-device link not permitted')) throw err
            copy = true
            logger.warn(err.message)
            logger.info('Falling back to copying packages from store')
            return Rx.Observable.fromPromise(linkPkgToAbsPath(copyPkg, resolvedPkg.node, opts))
          })
      if (resolvedPkg.node.hasBundledDependencies) {
        // link the bundled dependencies` bins
        return linkPkgContent$
          .mergeMap(() => {
            const binPath = path.join(resolvedPkg.node.hardlinkedLocation, 'node_modules', '.bin')
            const bundledModules = path.join(resolvedPkg.node.hardlinkedLocation, 'node_modules')
            return Rx.Observable.fromPromise(linkBins(bundledModules, binPath))
          })
          .mapTo({
            resolvedPkg,
          })
      }
      return linkPkgContent$
        .mapTo({
          resolvedPkg,
        })
    })
    .shareReplay(Infinity)

  return pkgWithLinkedContent$.mergeMap(linkedPkg => {
    return pkgWithLinkedModules$
      .single(withLinkedModules => withLinkedModules.resolvedPkg.node.absolutePath === linkedPkg.resolvedPkg.node.absolutePath)
      .mergeMap(linkedPkg => {
        if (!linkedPkg.dependenciesWithBins.length) {
          return Rx.Observable.of(linkedPkg.resolvedPkg)
        }
        return Rx.Observable.from(linkedPkg.dependenciesWithBins)
          .mergeMap(depWithBins => {
            return pkgWithLinkedContent$
              .map(_ => _.resolvedPkg.node)
              .filter(resolvedNode => resolvedNode.absolutePath === depWithBins.absolutePath)
              .concat(Rx.Observable.of(depWithBins))
              .take(1)
          })
          .mergeMap(resolvedNode => {
            return _linkBins(linkedPkg.resolvedPkg.node, resolvedNode)
          })
          .last()
      })
      .mapTo(linkedPkg.resolvedPkg.node.absolutePath)
  })
}

async function linkPkgToAbsPath (
  linkPkg: (fetchResult: PackageContentInfo, dependency: ResolvedNode, opts: {
    force: boolean,
    baseNodeModules: string,
  }) => Promise<void>,
  pkg: ResolvedNode,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
  }
) {
  const fetchResult = await pkg.fetchingFiles

  if (pkg.independent) return Rx.Observable.of(undefined)
  return limitLinking(() => linkPkg(fetchResult, pkg, opts))
}

function _linkBins (
  pkg: ResolvedNode,
  dependency: ResolvedNode
) {
  const binPath = path.join(pkg.hardlinkedLocation, 'node_modules', '.bin')

  if (!dependency.installable) return Rx.Observable.empty()

  return Rx.Observable.fromPromise(
    limitLinking(() => linkPkgBins(path.join(pkg.modules, dependency.name), binPath))
  )
}

function linkModules (
  pkg: ResolvedNode,
  deps: ResolvedNode[]
) {
  if (pkg.independent) return Rx.Observable.of(undefined)

  return Rx.Observable.fromPromise(
    limitLinking(() =>
      Promise.all(
        deps
          .filter(child => child.installable)
          .map(child => symlinkDependencyTo(child, pkg.modules))
      )
    )
  )
}

async function linkPkg (
  fetchResult: PackageContentInfo,
  dependency: ResolvedNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')

  if (fetchResult.isNew || opts.force || !await exists(pkgJsonPath) || !await pkgLinkedToStore(pkgJsonPath, dependency)) {
    await linkIndexedDir(dependency.path, dependency.hardlinkedLocation, fetchResult.index)
  }
}

async function copyPkg (
  fetchResult: PackageContentInfo,
  dependency: ResolvedNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const newlyFetched = await dependency.fetchingFiles

  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')
  if (newlyFetched || opts.force || !await exists(pkgJsonPath)) {
    await ncp(dependency.path, dependency.hardlinkedLocation)
  }
}

async function pkgLinkedToStore (pkgJsonPath: string, dependency: ResolvedNode) {
  const pkgJsonPathInStore = path.join(dependency.path, 'package.json')
  if (await isSameFile(pkgJsonPath, pkgJsonPathInStore)) return true
  logger.info(`Relinking ${dependency.hardlinkedLocation} from the store`)
  return false
}

async function isSameFile (file1: string, file2: string) {
  const stats = await Promise.all([fs.stat(file1), fs.stat(file2)])
  return stats[0].ino === stats[1].ino
}

function symlinkDependencyTo (dependency: ResolvedNode, dest: string) {
  dest = path.join(dest, dependency.name)
  return symlinkDir(dependency.hardlinkedLocation, dest)
}
