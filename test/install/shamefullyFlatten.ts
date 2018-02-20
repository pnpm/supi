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
