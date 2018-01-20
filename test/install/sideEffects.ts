import tape = require('tape')
import promisifyTape from 'tape-promise'
import {installPkgs} from 'supi'
import path = require('path')
import exists = require('path-exists')
import {
  prepare,
  testDefaults,
} from '../utils'

const test = promisifyTape(tape)

test('caching side effects of native package', async function (t) {
  const project = prepare(t)

  const opts = await testDefaults({sideEffectsCache: true})
  await installPkgs(['runas@3.1.1'], opts)

  t.ok(await exists(path.join('node_modules', 'runas', 'build')), 'build folder created')
  t.ok(await exists(path.join(opts.store, 'localhost+4873', 'runas', '3.1.1', 'side_effects', `${process.platform}-${process.arch}-${process.version.split('.')[0]}`, 'package', 'build')), 'build folder created in side effects cache')
})
