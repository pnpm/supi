import tape = require('tape')
import promisifyTape from 'tape-promise'
import {installPkgs, uninstall} from 'supi'
import {prepare, testDefaults} from '../utils'

const test = promisifyTape(tape)
test.only = promisifyTape(tape.only)

test('should flatten dependencies', async function (t) {
  const project = prepare(t)

  await installPkgs(['jsonify'], await testDefaults({shamefullyFlatten: true}))

  t.ok(project.has('jsonify'), 'jsonify installed correctly')
  t.ok(project.has('tap'), 'tap dependency flattened')
  t.ok(project.has('garbage'), 'garbage dependency flattened')
})

test('should remove flattened dependencies', async function (t) {
  const project = prepare(t)

  await installPkgs(['jsonify'], await testDefaults({shamefullyFlatten: true}))
  await uninstall(['jsonify'], await testDefaults({shamefullyFlatten: true}))

  t.ok(project.hasNot('jsonify'), 'jsonify removed correctly')
  t.ok(project.hasNot('tap'), 'tap dependency removed correctly')
  t.ok(project.hasNot('garbage'), 'garbage dependency removed correctly')
})

test('should not override root packages with flattened dependencies', async function (t) {
  const project = prepare(t)

  // this installs debug@3.1.0
  await installPkgs(['debug@3.1.0'], await testDefaults({shamefullyFlatten: true}))
  // this installs express@4.16.2, that depends on debug 2.6.9, but we don't want to flatten debug@2.6.9
  await installPkgs(['express@4.16.2'], await testDefaults({shamefullyFlatten: true}))

  t.equal(project.requireModule('debug/package.json').version, '3.1.0', 'debug did not get overridden by flattening')
})
