import path = require('path')
import logger from '@pnpm/logger'
import pnpmPkgJson from '../pnpmPkgJson'
import {LAYOUT_VERSION} from '../fs/modulesController'
import normalizeRegistryUrl = require('normalize-registry-url')
import {resolveStore} from 'package-store'
import { SupiOptions, StrictSupiOptions } from '../types';

const defaults = async (opts: SupiOptions) => {
  const packageManager = opts.packageManager || {
    name: pnpmPkgJson.name,
    version: pnpmPkgJson.version,
  }
  const prefix = opts.prefix || process.cwd()
  const store = await resolveStore(opts.store, prefix)
  return <StrictSupiOptions>{
    fetchRetries: 2,
    fetchRetryFactor: 10,
    fetchRetryMintimeout: 1e4, // 10 seconds
    fetchRetryMaxtimeout: 6e4, // 1 minute
    store,
    locks: path.join(store, '_locks'),
    ignoreScripts: false,
    strictSsl: true,
    tag: 'latest',
    production: true,
    development: true,
    bin: path.join(prefix, 'node_modules', '.bin'),
    prefix,
    nodeVersion: process.version,
    force: false,
    depth: 0,
    engineStrict: false,
    metaCache: new Map(),
    networkConcurrency: 16,
    fetchingConcurrency: 16,
    lockStaleDuration: 60 * 1000, // 1 minute
    lock: true,
    childConcurrency: 5,
    offline: false,
    registry: 'https://registry.npmjs.org/',
    userAgent: `${packageManager.name}/${packageManager.version} npm/? node/${process.version} ${process.platform} ${process.arch}`,
    rawNpmConfig: {},
    alwaysAuth: false,
    update: false,
    repeatInstallDepth: -1,
    optional: typeof opts.production === 'boolean' ? opts.production : true,
    independentLeaves: false,
    packageManager,
    verifyStoreIntegrity: true,
    hooks: {},
    savePrefix: '^',
    unsafePerm: process.platform === 'win32' ||
                process.platform === 'cygwin' ||
                !(process.getuid && process.setuid &&
                  process.getgid && process.setgid) ||
                process.getuid() !== 0,
    packageImportMethod: 'auto',
  }
}

export default async (
  opts?: SupiOptions,
  // TODO: remove this option.
  // extendOptions is now called twice, which should not really be happening
  logWarnings?: boolean,
): Promise<StrictSupiOptions> => {
  opts = opts || {}
  if (opts) {
    for (const key in opts) {
      if (opts[key] === undefined) {
        delete opts[key]
      }
    }
  }
  if (opts.storePath && !opts.store) {
    if (logWarnings !== false) {
      logger.warn('the `store-path` config is deprecated. Use `store` instead.')
    }
    opts.store = opts.storePath
  }
  const defaultOpts = await defaults(opts)
  const extendedOpts = {...defaultOpts, ...opts, store: defaultOpts.store}
  if (logWarnings !== false && extendedOpts.force) {
    logger.warn('using --force I sure hope you know what you are doing')
  }
  if (logWarnings !== false && extendedOpts.lock === false) {
    logger.warn('using --no-lock I sure hope you know what you are doing')
  }
  if (extendedOpts.userAgent.startsWith('npm/')) {
    extendedOpts.userAgent = `${extendedOpts.packageManager.name}/${extendedOpts.packageManager.version} ${extendedOpts.userAgent}`
  }
  extendedOpts.registry = normalizeRegistryUrl(extendedOpts.registry)
  if (extendedOpts.global) {
    const subfolder = LAYOUT_VERSION.toString() + (extendedOpts.independentLeaves ? '_independent_leaves' : '')
    extendedOpts.prefix = path.join(extendedOpts.prefix, subfolder)
  }
  extendedOpts.rawNpmConfig['registry'] = extendedOpts.registry

  extendedOpts.pending = extendedOpts.rawNpmConfig['pending']

  extendedOpts.customInstall = extendedOpts.rawNpmConfig['custom-install']
  if (extendedOpts.customInstall) {
    extendedOpts.pending = true
  }

  return extendedOpts
}
