import tape = require('tape')
import promisifyTape from 'tape-promise'
import sinon = require('sinon')
const test = promisifyTape(tape)
const testOnly = promisifyTape(tape.only)
import path = require('path')
import {
  prepare,
  isExecutable,
  pathToLocalPkg,
  testDefaults,
 } from './utils'
import promisify = require('util.promisify')
import ncpCB = require('ncp')
const ncp = promisify(ncpCB.ncp)
import {
  link,
  linkToGlobal,
  linkFromGlobal,
  installPkgs,
  RootLog,
} from 'supi'
import exists = require('path-exists')

test('relative link', async (t: tape.Test) => {
  const project = prepare(t, {
    dependencies: {
      'hello-world-js-bin': '*',
    },
  })

  const linkedPkgName = 'hello-world-js-bin'
  const linkedPkgPath = path.resolve('..', linkedPkgName)

  await ncp(pathToLocalPkg(linkedPkgName), linkedPkgPath)
  await link([`../${linkedPkgName}`], path.join(process.cwd(), 'node_modules'), await testDefaults())

  await isExecutable(t, path.resolve('node_modules', '.bin', 'hello-world-js-bin'))

  // The linked package has been installed successfully as well with bins linked
  // to node_modules/.bin
  await isExecutable(t, path.join(linkedPkgPath, 'node_modules', '.bin', 'cowsay'))

  const wantedShrinkwrap = await project.loadShrinkwrap()
  t.equal(wantedShrinkwrap.dependencies['hello-world-js-bin'], 'link:../hello-world-js-bin', 'link added to wanted shrinkwrap')
  t.equal(wantedShrinkwrap.specifiers['hello-world-js-bin'], '*', 'specifier of linked dependency added to shrinkwrap.yaml')

  const currentShrinkwrap = await project.loadCurrentShrinkwrap()
  t.equal(currentShrinkwrap.dependencies['hello-world-js-bin'], 'link:../hello-world-js-bin', 'link added to wanted shrinkwrap')
})

test('relative link is not rewritten by install', async (t: tape.Test) => {
  const project = prepare(t)

  const linkedPkgName = 'hello-world-js-bin'
  const linkedPkgPath = path.resolve('..', linkedPkgName)

  await ncp(pathToLocalPkg(linkedPkgName), linkedPkgPath)
  await link([`../${linkedPkgName}`], path.join(process.cwd(), 'node_modules'), await testDefaults())

  const reporter = sinon.spy()

  await installPkgs(['hello-world-js-bin'], await testDefaults({reporter}))

  t.ok(project.requireModule('hello-world-js-bin/package.json').isLocal)

  t.ok(reporter.calledWithMatch(<RootLog>{
    name: 'pnpm:root',
    level: 'debug',
    linked: {
      name: 'hello-world-js-bin',
      from: linkedPkgPath,
      to: path.resolve('node_modules'),
      // TODO: the dependencyType should be `undefined` in this case
    },
  }), 'linked root dependency logged')

  const wantedShrinkwrap = await project.loadShrinkwrap()
  t.equal(wantedShrinkwrap.dependencies['hello-world-js-bin'], 'link:../hello-world-js-bin', 'link still in wanted shrinkwrap')

  const currentShrinkwrap = await project.loadCurrentShrinkwrap()
  t.equal(currentShrinkwrap.dependencies['hello-world-js-bin'], 'link:../hello-world-js-bin', 'link still in wanted shrinkwrap')
})

test('global link', async function (t: tape.Test) {
  prepare(t)
  const projectPath = process.cwd()

  const linkedPkgName = 'hello-world-js-bin'
  const linkedPkgPath = path.resolve('..', linkedPkgName)

  await ncp(pathToLocalPkg(linkedPkgName), linkedPkgPath)

  process.chdir(linkedPkgPath)
  const globalPrefix = path.resolve('..', 'global')
  const globalBin = path.resolve('..', 'global', 'bin')
  await linkToGlobal(process.cwd(), await testDefaults({globalPrefix, globalBin}))

  isExecutable(t, path.join(globalBin, 'hello-world-js-bin'))

  // bins of dependencies should not be linked, see issue https://github.com/pnpm/pnpm/issues/905
  t.notOk(await exists(path.join(globalBin, 'cowsay')), 'cowsay not linked')
  t.notOk(await exists(path.join(globalBin, 'cowthink')), 'cowthink not linked')

  process.chdir(projectPath)

  await linkFromGlobal([linkedPkgName], process.cwd(), await testDefaults({globalPrefix}))

  isExecutable(t, path.resolve('node_modules', '.bin', 'hello-world-js-bin'))
})

test('failed linking should not create empty folder', async (t: tape.Test) => {
  prepare(t)

  const globalPrefix = path.resolve('..', 'global')

  try {
    await linkFromGlobal(['does-not-exist'], process.cwd(), await testDefaults({globalPrefix}))
    t.fail('should have failed')
  } catch (err) {
    t.notOk(await exists(path.join(globalPrefix, 'node_modules', 'does-not-exist')))
  }
})
