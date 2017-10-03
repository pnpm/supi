import tape = require('tape')
import promisifyTape from 'tape-promise'
import {
  prepare,
  testDefaults,
} from '../utils'
import {install, installPkgs} from '../../src'

const test = promisifyTape(tape)

test('dry-run installation', async (t: tape.Test) => {
  const project = prepare(t)

  await installPkgs(['is-positive@1.0.0'], testDefaults({dryRun: true}))

  await project.hasNot('rimraf')
  await project.storeHasNot('is-positive', '1.0.0')
})
