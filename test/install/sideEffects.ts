import fs = require('mz/fs')
import rimraf = require('rimraf-then')

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

test('using side effects cache', async function (t) {
  const project = prepare(t)

  // Right now, hardlink does not work with side effects
  const opts = await testDefaults({sideEffectsCache: true}, {}, {}, {packageImportMethod: 'copy'})
  await installPkgs(['runas@3.1.1'], opts)

  // Modify the side effects cache to make sure we are using it
  // TODO this test won't work anymore when we introduce integrity.json
  const cacheBuildDir = path.join(opts.store, 'localhost+4873', 'runas', '3.1.1', 'side_effects', `${process.platform}-${process.arch}-${process.version.split('.')[0]}`, 'package', 'build')
  await fs.writeFile(path.join(cacheBuildDir, 'new-file.txt'), 'some new content')

  await rimraf('node_modules')
  await installPkgs(['runas@3.1.1'], opts)

  t.ok(await exists(path.join('node_modules', 'runas', 'build', 'new-file.txt')), 'side effects cache correctly used')
})

test('readonly side effects cache', async function (t) {
  const project = prepare(t)

  const opts1 = await testDefaults({sideEffectsCache: true})
  await installPkgs(['runas@3.1.1'], opts1)

  // Modify the side effects cache to make sure we are using it
  // TODO this test won't work anymore when we introduce integrity.json
  const cacheBuildDir = path.join(opts1.store, 'localhost+4873', 'runas', '3.1.1', 'side_effects', `${process.platform}-${process.arch}-${process.version.split('.')[0]}`, 'package', 'build')
  await fs.writeFile(path.join(cacheBuildDir, 'new-file.txt'), 'some new content')

  await rimraf('node_modules')
  const opts2 = await testDefaults({sideEffectsCacheReadonly: true}, {}, {}, {packageImportMethod: 'copy'})
  await installPkgs(['runas@3.1.1'], opts2)

  t.ok(await exists(path.join('node_modules', 'runas', 'build', 'new-file.txt')), 'side effects cache correctly used')

  await rimraf('node_modules')
  // changing version to make sure we don't create the cache
  await await installPkgs(['runas@3.1.0'], opts2)

  t.ok(await exists(path.join('node_modules', 'runas', 'build')), 'build folder created')
  t.notOk(await exists(path.join(opts2.store, 'localhost+4873', 'runas', '3.1.0', 'side_effects', `${process.platform}-${process.arch}-${process.version.split('.')[0]}`, 'package', 'build')), 'cache folder not created')
})
