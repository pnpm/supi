import path = require('path')
import tape = require('tape')
import promisifyTape from 'tape-promise'

import checkCompatibility from '../src/api/checkCompatibility'
import {Modules, LAYOUT_VERSION} from '../src/fs/modulesController'

const test = promisifyTape(tape)

test('does not throw when drive is different on windows', async (t: tape.Test) => {
  t.doesNotThrow(() => {
    checkCompatibility(
      {
        store: 'Z:\\foo\\bar',
        layoutVersion: LAYOUT_VERSION
      } as Modules,
      {
        storePath: 'z:\\foo\bar',
        modulesPath: undefined
      },
      path.win32 as typeof path
    );
  });
});

test('throws when drive is different on posix', async (t: tape.Test) => {
  t.throws(() => {
    checkCompatibility(
      {
        store: 'Z:\\foo\\bar',
        layoutVersion: LAYOUT_VERSION
      } as Modules,
      {
        storePath: 'z:\\foo\bar',
        modulesPath: undefined
      }
    );
  });
});

test('does not throw when path is identical', async (t: tape.Test) => {
  t.doesNotThrow(() => {
    checkCompatibility(
      {
        store: 'z:\\foo\\bar',
        layoutVersion: LAYOUT_VERSION
      } as Modules,
      {
        storePath: 'z:\\foo\\bar',
        modulesPath: undefined
      }
    );
  });
});

test('throws when path is different', async (t: tape.Test) => {
  t.throws(() => {
    checkCompatibility(
      {
        store: 'z:\\different\\path\\to\\bar',
        layoutVersion: LAYOUT_VERSION
      } as Modules,
      {
        storePath: 'z:\\foo\\bar',
        modulesPath: undefined
      }
    );
  });
});