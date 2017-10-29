'use strict'
const npsUtils = require('nps-utils')

module.exports = {
  scripts: {
    info: 'npm-scripts-info',
    default: 'nps "tsc --watch"',
    commit: {
      description: "Run Git commit wizard",
      script: 'commit'
    },
    lint: 'tslint -c tslint.json --project .',
    pnpmRegistryMock: 'pnpm-registry-mock',
    pretest: 'rimraf ../.tmp/ && pnpm-registry-mock prepare && preview',
    test: {
      tap: 'ts-node --fast --no-cache --cache-directory ./ts-cache test',
      e2e: npsUtils.concurrent.nps('pnpm-registry-mock', 'test.tap'),
      default: 'nps pretest && nps test.e2e'
    },
    tsc: 'rimraf lib && tsc',
    prepublishOnly: 'npm run tsc'
  }
}
