import path = require('path')
import logger from '@pnpm/logger'
import {deprecationLogger} from './loggers'
import R = require('ramda')
import getNpmTarballUrl from 'get-npm-tarball-url'
import exists = require('path-exists')
import url = require('url')
import {
  PackageFilesResponse,
  PackageResponse,
} from '@pnpm/package-requester'
import {Resolution} from '@pnpm/resolver-base'
import {InstallContext, InstalledPackages} from './api/install'
import {
  WantedDependency,
} from './types'
import {
  ReadPackageHook,
  Dependencies,
  PackageManifest,
} from '@pnpm/types'
import memoize from './memoize'
import logStatus from './logging/logInstallStatus'
import fs = require('mz/fs')
import * as dp from 'dependency-path'
import {
  Shrinkwrap,
  DependencyShrinkwrap,
  ResolvedDependencies,
} from 'pnpm-shrinkwrap'
import depsToSpecs from './depsToSpecs'
import getIsInstallable from './install/getIsInstallable'
import getPkgInfoFromShr from './getPkgInfoFromShr'
import {
  nodeIdContainsSequence,
  createNodeId,
} from './nodeIdUtils'
import encodePkgId from './encodePkgId'
import semver = require('semver')

const ENGINE_NAME = `${process.platform}-${process.arch}-node-${process.version.split('.')[0]}`

export type PkgAddress = {
  alias: string,
  nodeId: string,
  pkgId: string,
  normalizedPref?: string, // is returned only for root dependencies
}

export type InstalledPackage = {
  id: string,
  resolution: Resolution,
  prod: boolean,
  dev: boolean,
  optional: boolean,
  fetchingFiles: Promise<PackageFilesResponse>,
  finishing: Promise<void>,
  path: string,
  specRaw: string,
  name: string,
  version: string,
  peerDependencies: Dependencies,
  optionalDependencies: Set<string>,
  hasBundledDependencies: boolean,
  additionalInfo: {
    deprecated?: string,
    peerDependencies?: Dependencies,
    bundleDependencies?: string[],
    bundledDependencies?: string[],
    engines?: {
      node?: string,
      npm?: string,
    },
    cpu?: string[],
    os?: string[],
  },
  engineCache?: string,
}

export default async function resolveDependencies (
  ctx: InstallContext,
  wantedDependencies: WantedDependency[],
  options: {
    keypath: string[],
    parentNodeId: string,
    currentDepth: number,
    resolvedDependencies?: ResolvedDependencies,
    // If the package has been updated, the dependencies
    // which were used by the previous version are passed
    // via this option
    preferedDependencies?: ResolvedDependencies,
    parentIsInstallable?: boolean,
    update: boolean,
    readPackageHook?: ReadPackageHook,
    hasManifestInShrinkwrap: boolean,
    sideEffectsCache: boolean,
    reinstallForFlatten?: boolean,
    shamefullyFlatten?: boolean,
  }
): Promise<PkgAddress[]> {
  const resolvedDependencies = options.resolvedDependencies || {}
  const preferedDependencies = options.preferedDependencies || {}
  const update = options.update && options.currentDepth <= ctx.depth
  const pkgAddresses = <PkgAddress[]>(
    await Promise.all(
      wantedDependencies
        .map(async (wantedDependency: WantedDependency) => {
          let reference = wantedDependency.alias && resolvedDependencies[wantedDependency.alias]
          let proceed = false

          // If dependencies that were used by the previous version of the package
          // satisfy the newer version's requirements, then pnpm tries to keep
          // the previous dependency.
          // So for example, if foo@1.0.0 had bar@1.0.0 as a dependency
          // and foo was updated to 1.1.0 which depends on bar ^1.0.0
          // then bar@1.0.0 can be reused for foo@1.1.0
          if (!reference && wantedDependency.alias && semver.validRange(wantedDependency.pref) !== null &&
            preferedDependencies[wantedDependency.alias] &&
            refSatisfies(preferedDependencies[wantedDependency.alias], wantedDependency.pref)) {
            proceed = true
            reference = preferedDependencies[wantedDependency.alias]
          }

          return await install(wantedDependency, ctx, {
            keypath: options.keypath,
            parentNodeId: options.parentNodeId,
            currentDepth: options.currentDepth,
            parentIsInstallable: options.parentIsInstallable,
            readPackageHook: options.readPackageHook,
            hasManifestInShrinkwrap: options.hasManifestInShrinkwrap,
            update,
            proceed,
            reinstallForFlatten: options.reinstallForFlatten,
            shamefullyFlatten: options.shamefullyFlatten,
            sideEffectsCache: options.sideEffectsCache,
            ...getInfoFromShrinkwrap(ctx.wantedShrinkwrap, reference, wantedDependency.alias, ctx.registry),
          })
        })
    )
  )
  .filter(Boolean)

  return pkgAddresses
}

// A reference is not always a version.
// We assume that it does not satisfy the range if it's raw form is not a version
// This logic can be made smarter because
// if the reference is /foo/1.0.0/bar@2.0.0, foo's version if 1.0.0
function refSatisfies (reference: string, range: string) {
  try {
    return semver.satisfies(reference, range, true)
  } catch (err) {
    return false
  }
}

function getInfoFromShrinkwrap (
  shrinkwrap: Shrinkwrap,
  reference: string | undefined,
  pkgName: string | undefined,
  registry: string,
) {
  if (!reference || !pkgName) {
    return null
  }

  const relDepPath = dp.refToRelative(reference, pkgName)

  if (!relDepPath) {
    return null
  }

  const dependencyShrinkwrap = shrinkwrap.packages && shrinkwrap.packages[relDepPath]

  if (dependencyShrinkwrap) {
    const depPath = dp.resolve(shrinkwrap.registry, relDepPath)
    return {
      relDepPath,
      depPath,
      dependencyShrinkwrap,
      pkgId: dependencyShrinkwrap.id || depPath,
      shrinkwrapResolution: dependencyShrToResolution(relDepPath, dependencyShrinkwrap, shrinkwrap.registry),
      resolvedDependencies: {
        ...dependencyShrinkwrap.dependencies,
        ...dependencyShrinkwrap.optionalDependencies,
      },
      optionalDependencyNames: R.keys(dependencyShrinkwrap.optionalDependencies),
    }
  } else {
    return {
      relDepPath,
      pkgId: dp.resolve(shrinkwrap.registry, relDepPath),
    }
  }
}

function dependencyShrToResolution (
  relDepPath: string,
  depShr: DependencyShrinkwrap,
  registry: string
): Resolution {
  if (depShr.resolution['type']) {
    return depShr.resolution as Resolution
  }
  if (!depShr.resolution['tarball']) {
    return {
      ...depShr.resolution,
      tarball: getTarball(),
      registry: depShr.resolution['registry'] || registry,
    } as Resolution
  }
  if (depShr.resolution['tarball'].startsWith('file:')) {
    return depShr.resolution as Resolution
  }
  return {
    ...depShr.resolution,
    tarball: url.resolve(registry, depShr.resolution['tarball']),
  } as Resolution

  function getTarball () {
    const parsed = dp.parse(relDepPath)
    if (!parsed['name'] || !parsed['version']) {
      throw new Error(`Couldn't get tarball URL from dependency path ${relDepPath}`)
    }
    return getNpmTarballUrl(parsed['name'], parsed['version'], {registry})
  }
}

async function install (
  wantedDependency: WantedDependency,
  ctx: InstallContext,
  options: {
    keypath: string[], // TODO: remove. Currently used only for logging
    pkgId?: string,
    depPath?: string,
    relDepPath?: string,
    parentNodeId: string,
    currentDepth: number,
    dependencyShrinkwrap?: DependencyShrinkwrap,
    shrinkwrapResolution?: Resolution,
    resolvedDependencies?: ResolvedDependencies,
    optionalDependencyNames?: string[],
    parentIsInstallable?: boolean,
    update: boolean,
    proceed: boolean,
    readPackageHook?: ReadPackageHook,
    hasManifestInShrinkwrap: boolean,
    sideEffectsCache: boolean,
    reinstallForFlatten?: boolean,
    shamefullyFlatten?: boolean,
  }
): Promise<PkgAddress | null> {
  const keypath = options.keypath || []
  const proceed = options.proceed || !options.shrinkwrapResolution || ctx.force || keypath.length <= ctx.depth
  const parentIsInstallable = options.parentIsInstallable === undefined || options.parentIsInstallable

  if (!options.shamefullyFlatten && !options.reinstallForFlatten && !proceed && options.depPath &&
    // if package is not in `node_modules/.shrinkwrap.yaml`
    // we can safely assume that it doesn't exist in `node_modules`
    options.relDepPath && ctx.currentShrinkwrap.packages && ctx.currentShrinkwrap.packages[options.relDepPath] &&
    await exists(path.join(ctx.nodeModules, `.${options.depPath}`)) && (
      options.currentDepth > 0 || wantedDependency.alias && await exists(path.join(ctx.nodeModules, wantedDependency.alias))
    )) {

    return null
  }

  const scope = wantedDependency.alias && getScope(wantedDependency.alias)
  const registry = normalizeRegistry(scope && ctx.rawNpmConfig[`${scope}:registry`] || ctx.registry)

  const dependentId = keypath[keypath.length - 1]
  const loggedPkg = {
    rawSpec: wantedDependency.raw,
    name: wantedDependency.alias,
    dependentId,
  }
  logStatus({
    status: 'installing',
    pkg: loggedPkg,
  })

  let pkgResponse!: PackageResponse
  try {
    pkgResponse = await ctx.storeController.requestPackage(wantedDependency, {
      defaultTag: ctx.defaultTag,
      loggedPkg,
      update: options.update,
      registry,
      prefix: ctx.prefix,
      shrinkwrapResolution: options.shrinkwrapResolution,
      currentPkgId: options.pkgId,
      verifyStoreIntegrity: ctx.verifyStoreInegrity,
      downloadPriority: -options.currentDepth,
      preferredVersions: ctx.preferredVersions,
      skipFetch: ctx.dryRun,
      sideEffectsCache: options.sideEffectsCache
    })
  } catch (err) {
    if (wantedDependency.optional) {
      logger.warn({
        message: `Skipping optional dependency ${wantedDependency.raw}. ${err.toString()}`,
        err,
      })
      return null
    }
    throw err
  }

  pkgResponse.body.id = encodePkgId(pkgResponse.body.id)

  if (pkgResponse.body.isLocal) {
    const pkg = pkgResponse.body.manifest || await pkgResponse['fetchingManifest']
    if (options.currentDepth > 0) {
      logger.warn(`Ignoring file dependency because it is not a root dependency ${wantedDependency}`)
    } else {
      ctx.localPackages.push({
        alias: wantedDependency.alias || pkg.name,
        id: pkgResponse.body.id,
        specRaw: wantedDependency.raw,
        name: pkg.name,
        version: pkg.version,
        dev: wantedDependency.dev,
        optional: wantedDependency.optional,
        resolution: pkgResponse.body.resolution,
        normalizedPref: pkgResponse.body.normalizedPref,
      })
    }
    logStatus({status: 'downloaded_manifest', pkgId: pkgResponse.body.id, pkgVersion: pkg.version})
    return null
  }

  // For the root dependency dependentId will be undefined,
  // that's why checking it
  if (dependentId && nodeIdContainsSequence(options.parentNodeId, dependentId, pkgResponse.body.id)) {
    return null
  }

  let pkg: PackageManifest
  let useManifestInfoFromShrinkwrap = false
  if (options.hasManifestInShrinkwrap && !options.update && options.dependencyShrinkwrap && options.relDepPath) {
    useManifestInfoFromShrinkwrap = true
    pkg = Object.assign(
      getPkgInfoFromShr(options.relDepPath, options.dependencyShrinkwrap),
      options.dependencyShrinkwrap
    )
    if (pkg.peerDependencies) {
      const deps = pkg.dependencies || {}
      R.keys(pkg.peerDependencies).forEach(peer => {
        delete deps[peer]
        if (options.resolvedDependencies) {
          delete options.resolvedDependencies[peer]
        }
      })
    }
  } else {
    try {
      pkg = options.readPackageHook
        ? options.readPackageHook(pkgResponse.body['manifest'] || await pkgResponse['fetchingManifest'])
        : pkgResponse.body['manifest'] || await pkgResponse['fetchingManifest']
    } catch (err) {
      // avoiding unhandled promise rejections
      if (pkgResponse['finishing']) pkgResponse['finishing'].catch((err: Error) => {})
      if (pkgResponse['fetchingFiles']) pkgResponse['fetchingFiles'].catch((err: Error) => {})
      throw err
    }
  }
  if (options.currentDepth === 0 && pkgResponse.body.latest && pkgResponse.body.latest !== pkg.version) {
    ctx.outdatedPkgs[pkgResponse.body.id] = pkgResponse.body.latest
  }
  if (pkg.deprecated) {
    deprecationLogger.warn({
      pkgName: pkg.name,
      pkgVersion: pkg.version,
      pkgId: pkgResponse.body.id,
      deprecated: pkg.deprecated,
      depth: options.currentDepth,
    })
  }

  logStatus({status: 'downloaded_manifest', pkgId: pkgResponse.body.id, pkgVersion: pkg.version})

  // using colon as it will never be used inside a package ID
  const nodeId = createNodeId(options.parentNodeId, pkgResponse.body.id)

  const currentIsInstallable = (
      ctx.force ||
      await getIsInstallable(pkgResponse.body.id, pkg, {
        nodeId,
        installs: ctx.installs,
        optional: wantedDependency.optional,
        engineStrict: ctx.engineStrict,
        nodeVersion: ctx.nodeVersion,
        pnpmVersion: ctx.pnpmVersion,
      })
    )
  const installable = parentIsInstallable && currentIsInstallable

  if (installable) {
    ctx.skipped.delete(pkgResponse.body.id)
  }
  if (!ctx.installs[pkgResponse.body.id]) {
    if (!installable) {
      // optional dependencies are resolved for consistent shrinkwrap.yaml files
      // but installed only on machines that are supported by the package
      ctx.skipped.add(pkgResponse.body.id)
    }

    const peerDependencies = peerDependenciesWithoutOwn(pkg)

    ctx.installs[pkgResponse.body.id] = {
      id: pkgResponse.body.id,
      resolution: pkgResponse.body.resolution,
      optional: wantedDependency.optional,
      name: pkg.name,
      version: pkg.version,
      prod: !wantedDependency.dev && !wantedDependency.optional,
      dev: wantedDependency.dev,
      fetchingFiles: pkgResponse['fetchingFiles'],
      finishing: pkgResponse['finishing'],
      path: pkgResponse.body.inStoreLocation,
      specRaw: wantedDependency.raw,
      peerDependencies: peerDependencies || {},
      optionalDependencies: new Set(R.keys(pkg.optionalDependencies)),
      hasBundledDependencies: !!(pkg.bundledDependencies || pkg.bundleDependencies),
      additionalInfo: {
        deprecated: pkg.deprecated,
        peerDependencies,
        bundleDependencies: pkg.bundleDependencies,
        bundledDependencies: pkg.bundledDependencies,
        engines: pkg.engines,
        cpu: pkg.cpu,
        os: pkg.os,
      },
      engineCache: !ctx.force && pkgResponse.body.cacheByEngine && pkgResponse.body.cacheByEngine[ENGINE_NAME],
    }
    const children = await resolveDependenciesOfPackage(
      pkg,
      ctx,
      {
        parentIsInstallable: installable,
        currentDepth: options.currentDepth + 1,
        parentNodeId: nodeId,
        keypath: options.keypath.concat([ pkgResponse.body.id ]),
        resolvedDependencies: pkgResponse.body.id !== options.pkgId
          ? undefined
          : options.resolvedDependencies,
        preferedDependencies: pkgResponse.body.id !== options.pkgId
          ? options.resolvedDependencies
          : undefined,
        optionalDependencyNames: options.optionalDependencyNames,
        update: options.update,
        readPackageHook: options.readPackageHook,
        hasManifestInShrinkwrap: options.hasManifestInShrinkwrap,
        useManifestInfoFromShrinkwrap,
        sideEffectsCache: options.sideEffectsCache,
        reinstallForFlatten: options.reinstallForFlatten,
        shamefullyFlatten: options.shamefullyFlatten,
      }
    )
    ctx.childrenByParentId[pkgResponse.body.id] = children.map(child => ({
      alias: child.alias,
      pkgId: child.pkgId,
    }))
    ctx.tree[nodeId] = {
      pkg: ctx.installs[pkgResponse.body.id],
      children: children.reduce((children, child) => {
        children[child.alias] = child.nodeId
        return children
      }, {}),
      depth: options.currentDepth,
      installable,
    }
  } else {
    ctx.installs[pkgResponse.body.id].prod = ctx.installs[pkgResponse.body.id].prod || !wantedDependency.dev && !wantedDependency.optional
    ctx.installs[pkgResponse.body.id].dev = ctx.installs[pkgResponse.body.id].dev || wantedDependency.dev
    ctx.installs[pkgResponse.body.id].optional = ctx.installs[pkgResponse.body.id].optional && wantedDependency.optional

    ctx.nodesToBuild.push({
      alias: wantedDependency.alias || pkg.name,
      nodeId,
      pkg: ctx.installs[pkgResponse.body.id],
      depth: options.currentDepth,
      installable,
    })
  }
  // we need this for saving to package.json
  if (options.currentDepth === 0) {
    ctx.installs[pkgResponse.body.id].specRaw = wantedDependency.raw
  }

  logStatus({status: 'dependencies_installed', pkgId: pkgResponse.body.id})

  return {
    alias: wantedDependency.alias || pkg.name,
    nodeId,
    pkgId: pkgResponse.body.id,
    normalizedPref: options.currentDepth === 0 ? pkgResponse.body.normalizedPref : undefined,
  }
}

function getScope (pkgName: string): string | null {
  if (pkgName[0] === '@') {
    return pkgName.substr(0, pkgName.indexOf('/'))
  }
  return null
}

function peerDependenciesWithoutOwn (pkg: PackageManifest) {
  if (!pkg.peerDependencies) return pkg.peerDependencies
  const ownDeps = new Set(
    R.keys(pkg.dependencies).concat(R.keys(pkg.optionalDependencies))
  )
  const result = {}
  for (let peer of R.keys(pkg.peerDependencies)) {
    if (ownDeps.has(peer)) continue
    result[peer] = pkg.peerDependencies[peer]
  }
  if (R.isEmpty(result)) return undefined
  return result
}

function normalizeRegistry (registry: string) {
  if (registry.endsWith('/')) return registry
  return `${registry}/`
}

async function resolveDependenciesOfPackage (
  pkg: PackageManifest,
  ctx: InstallContext,
  opts: {
    keypath: string[],
    parentNodeId: string,
    currentDepth: number,
    resolvedDependencies?: ResolvedDependencies,
    preferedDependencies?: ResolvedDependencies,
    optionalDependencyNames?: string[],
    parentIsInstallable: boolean,
    update: boolean,
    readPackageHook?: ReadPackageHook,
    hasManifestInShrinkwrap: boolean,
    useManifestInfoFromShrinkwrap: boolean,
    sideEffectsCache: boolean,
    reinstallForFlatten?: boolean,
    shamefullyFlatten?: boolean,
  }
): Promise<PkgAddress[]> {

  const bundledDeps = pkg.bundleDependencies || pkg.bundledDependencies || []
  const filterDeps = getNotBundledDeps.bind(null, bundledDeps)
  let deps = depsToSpecs(
    filterDeps({...pkg.optionalDependencies, ...pkg.dependencies}),
    {
      devDependencies: {},
      optionalDependencies: pkg.optionalDependencies || {},
    }
  )
  if (opts.hasManifestInShrinkwrap && !deps.length && opts.resolvedDependencies && opts.useManifestInfoFromShrinkwrap) {
    const optionalDependencyNames = opts.optionalDependencyNames || []
    deps = R.keys(opts.resolvedDependencies)
      .map(depName => (<WantedDependency>{
        alias: depName,
        optional: optionalDependencyNames.indexOf(depName) !== -1,
      }))
  }

  return await resolveDependencies(ctx, deps, opts)
}

function getNotBundledDeps (bundledDeps: string[], deps: Dependencies) {
  return Object.keys(deps)
    .filter(depName => bundledDeps.indexOf(depName) === -1)
    .reduce((notBundledDeps, depName) => {
      notBundledDeps[depName] = deps[depName]
      return notBundledDeps
    }, {})
}
