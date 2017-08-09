import * as dp from 'dependency-path'
import {absolutePathToRef} from '../fs/shrinkwrap'
import {
  Shrinkwrap,
  DependencyShrinkwrap,
  ShrinkwrapResolution,
  ResolvedDependencies,
} from 'pnpm-shrinkwrap'
import {DependencyTreeNodeMap, DependencyTreeNode} from './resolvePeers'
import {Resolution} from 'package-store'
import R = require('ramda')
import Rx = require('@reactivex/rxjs')
import {Package} from '../types'

export type DependencyShrinkwrapContainer = {
  dependencyPath: string,
  dependencyShrinkwrap: DependencyShrinkwrap,
  dependencyTreeNode: DependencyTreeNode,
  dependencies: DependencyTreeNode[],
  optionalDependencies: DependencyTreeNode[],
}

export default function (
  dep$: Rx.Observable<DependencyTreeNode>,
  shrinkwrap: Shrinkwrap,
  pkg: Package
): Rx.Observable<DependencyShrinkwrapContainer> {
  const packages = shrinkwrap.packages || {}
  return dep$.mergeMap(dep => {
    const dependencyPath = dp.relative(shrinkwrap.registry, dep.absolutePath)
    return dep.children$
    .mergeMap(childAbsolutePath => {
      return dep$
        .filter(subdep => childAbsolutePath === subdep.absolutePath)
        .take(1)
    })
    .reduce((acc, subdep) => {
      if (dep.optionalDependencies.has(subdep.name)) {
        acc.optionalDependencies.push(subdep)
      } else {
        acc.dependencies.push(subdep)
      }
      return acc
    }, {optionalDependencies: [] as DependencyTreeNode[], dependencies: [] as DependencyTreeNode[]})
    .map(result => ({
      dependencyTreeNode: dep,
      dependencyPath,
      dependencies: result.dependencies,
      optionalDependencies: result.optionalDependencies,
      dependencyShrinkwrap: toShrDependency({
        dependencyAbsolutePath: dep.absolutePath,
        id: dep.id,
        dependencyPath,
        resolution: dep.resolution,
        updatedOptionalDeps: result.optionalDependencies,
        updatedDeps: result.dependencies,
        registry: shrinkwrap.registry,
        prevResolvedDeps: packages[dependencyPath] && packages[dependencyPath].dependencies || {},
        prevResolvedOptionalDeps: packages[dependencyPath] && packages[dependencyPath].optionalDependencies || {},
        dev: dep.dev,
        optional: dep.optional,
      })
    }))
  })
}

function toShrDependency (
  opts: {
    dependencyAbsolutePath: string,
    id: string,
    dependencyPath: string,
    resolution: Resolution,
    registry: string,
    updatedDeps: DependencyTreeNode[],
    updatedOptionalDeps: DependencyTreeNode[],
    prevResolvedDeps: ResolvedDependencies,
    prevResolvedOptionalDeps: ResolvedDependencies,
    dev: boolean,
    optional: boolean,
  }
): DependencyShrinkwrap {
  const shrResolution = toShrResolution(opts.dependencyPath, opts.resolution, opts.registry)
  const newResolvedDeps = updateResolvedDeps(opts.prevResolvedDeps, opts.updatedDeps, opts.registry)
  const newResolvedOptionalDeps = updateResolvedDeps(opts.prevResolvedOptionalDeps, opts.updatedOptionalDeps, opts.registry)
  const result = {
    resolution: shrResolution
  }
  if (!R.isEmpty(newResolvedDeps)) {
    result['dependencies'] = newResolvedDeps
  }
  if (!R.isEmpty(newResolvedOptionalDeps)) {
    result['optionalDependencies'] = newResolvedOptionalDeps
  }
  if (opts.dev) {
    result['dev'] = true
  }
  if (opts.optional) {
    result['optional'] = true
  }
  if (opts.dependencyAbsolutePath !== opts.id) {
    result['id'] = opts.id
  }
  return result
}

// previous resolutions should not be removed from shrinkwrap
// as installation might not reanalize the whole dependency tree
// the `depth` property defines how deep should dependencies be checked
function updateResolvedDeps (
  prevResolvedDeps: ResolvedDependencies,
  updatedDeps: DependencyTreeNode[],
  registry: string
) {
  const newResolvedDeps = R.fromPairs<string>(
    updatedDeps
      .map((dep): R.KeyValuePair<string, string> => [
        dep.name,
        absolutePathToRef(dep.absolutePath, dep.name, dep.resolution, registry)
      ])
  )
  return R.merge(
    prevResolvedDeps,
    newResolvedDeps
  )
}

function toShrResolution (
  dependencyPath: string,
  resolution: Resolution,
  registry: string
): ShrinkwrapResolution {
  if (dp.isAbsolute(dependencyPath) || resolution.type !== undefined || !resolution.integrity) {
    return resolution
  }
  // This might be not the best solution to identify non-standard tarball URLs in the long run
  // but it at least solves the issues with npm Enterprise. See https://github.com/pnpm/pnpm/issues/867
  if (!resolution.tarball.includes('/-/')) {
    return {
      integrity: resolution.integrity,
      tarball: relativeTarball(resolution.tarball, registry),
    }
  }
  return {
    integrity: resolution.integrity,
  }
}

function relativeTarball (tarball: string, registry: string) {
  if (tarball.substr(0, registry.length) === registry) {
    return tarball.substr(registry.length - 1)
  }
  return tarball
}
