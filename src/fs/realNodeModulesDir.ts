import fs = require('mz/fs')
import path = require('path')

const CACHE: {[prefix: string]: string} = {}

export default async function realNodeModulesDir (prefix: string): Promise<string> {
  if (!CACHE[prefix]) {
    const dirName = path.join(prefix, 'node_modules')
    try {
      CACHE[prefix] = await fs.realpath(dirName)
    } catch (err) {
      if (err['code'] === 'ENOENT') {
        CACHE[prefix] = dirName
      } else {
        throw err
      }
    }
  }
  return CACHE[prefix]
}
