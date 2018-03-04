import path = require('path')
import loadJsonFile = require('load-json-file')
import symlinkDir = require('symlink-dir')
import logger, {streamParser} from '@pnpm/logger'
import {install} from './install'
import pathAbsolute = require('path-absolute')
import normalize = require('normalize-path')
import {linkPkgBins} from '../link/linkBins'
import extendOptions, {
  InstallOptions,
} from './extendInstallOptions'
import readShrinkwrapFile from '../readShrinkwrapFiles'
import {prune as pruneNodeModules} from './prune'
import {
  Shrinkwrap,
  prune as pruneShrinkwrap,
  write as saveShrinkwrap,
  writeCurrentOnly as saveCurrentShrinkwrapOnly,
} from 'pnpm-shrinkwrap'

const linkLogger = logger('link')

export default async function link (
  linkFrom: string,
  destModules: string,
  maybeOpts: InstallOptions & {
    skipInstall?: boolean,
    linkToBin?: string,
  }
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)

  if (!maybeOpts || !maybeOpts.skipInstall) {
    await install({
      ...opts,
      prefix: linkFrom,
      bin: path.join(linkFrom, 'node_modules', '.bin'),
      global: false,
    })
  }
  const shrFiles = await readShrinkwrapFile({
    prefix: opts.prefix,
    shrinkwrap: opts.shrinkwrap,
    force: opts.force,
    registry: opts.registry,
  })
  const linkedPkg = await loadJsonFile(path.join(linkFrom, 'package.json'))
  const updatedCurrentShrinkwrap = addLinkToShrinkwrap(shrFiles.currentShrinkwrap, opts.prefix, linkFrom, linkedPkg.name)
  const updatedWantedShrinkwrap = addLinkToShrinkwrap(shrFiles.wantedShrinkwrap, opts.prefix, linkFrom, linkedPkg.name)

  await linkToModules(linkedPkg.name, linkFrom, destModules)

  const linkToBin = maybeOpts && maybeOpts.linkToBin || path.join(destModules, '.bin')
  await linkPkgBins(linkFrom, linkToBin)

  if (opts.shrinkwrap) {
    await saveShrinkwrap(opts.prefix, updatedWantedShrinkwrap, updatedCurrentShrinkwrap)
  } else {
    await saveCurrentShrinkwrapOnly(opts.prefix, updatedCurrentShrinkwrap)
  }

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }

  // TODO: call an internal implementation maybe, so that there would be no need to
  // unattach and attach reporter again
  // TODO: cover pruning after linking with tests
  await pruneNodeModules(opts)
}

function addLinkToShrinkwrap (shr: Shrinkwrap, prefix: string, linkFrom: string, linkedPkgName: string) {
  const packagePath = normalize(path.relative(prefix, linkFrom))
  const legacyId = `file:${packagePath}`
  const id = `link:${packagePath}`
  if (shr.devDependencies && shr.devDependencies[linkedPkgName]) {
    if (shr.devDependencies[linkedPkgName] !== legacyId) {
      shr.devDependencies[linkedPkgName] = id
    }
  } else if (shr.optionalDependencies && shr.optionalDependencies[linkedPkgName]) {
    if (shr.optionalDependencies[linkedPkgName] !== legacyId) {
      shr.optionalDependencies[linkedPkgName] = id
    }
  } else if (!shr.dependencies || shr.dependencies[linkedPkgName] !== legacyId) {
    shr.dependencies = shr.dependencies || {}
    shr.dependencies[linkedPkgName] = id
  }
  return pruneShrinkwrap(shr)
}

async function linkToModules (pkgName: string, linkFrom: string, modules: string) {
  const dest = path.join(modules, pkgName)
  linkLogger.info(`${dest} -> ${linkFrom}`)
  await symlinkDir(linkFrom, dest)
}

export async function linkFromGlobal (
  pkgName: string,
  linkTo: string,
  maybeOpts: InstallOptions & {globalPrefix: string}
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const globalPkgPath = pathAbsolute(maybeOpts.globalPrefix)
  const linkedPkgPath = path.join(globalPkgPath, 'node_modules', pkgName)
  await link(linkedPkgPath, path.join(linkTo, 'node_modules'), opts)

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }
}

export async function linkToGlobal (
  linkFrom: string,
  maybeOpts: InstallOptions & {
    globalPrefix: string,
    globalBin: string,
  }
) {
  const reporter = maybeOpts && maybeOpts.reporter
  if (reporter) {
    streamParser.on('data', reporter)
  }
  const opts = await extendOptions(maybeOpts)
  const globalPkgPath = pathAbsolute(maybeOpts.globalPrefix)
  await link(linkFrom, path.join(globalPkgPath, 'node_modules'), {
    ...opts,
    linkToBin: maybeOpts.globalBin,
  })

  if (reporter) {
    streamParser.removeListener('data', reporter)
  }
}
