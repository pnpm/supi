// The only reason package IDs are encoded is to avoid colons.
// Otherwise, it would be impossible to split the node ID back to package IDs reliably.
// See issue https://github.com/pnpm/pnpm/issues/986

export function nodeIdContainsSequence (nodeId: string, pkg1: string, pkg2: string) {
  return nodeId.indexOf(`:${encodeURIComponent(pkg1)}:${encodeURIComponent(pkg2)}:`) !== -1
}

export function createNodeId (parentNodeId: string, pkgId: string) {
  return `${parentNodeId}${encodeURIComponent(pkgId)}:`
}

export function splitNodeId (nodeId: string) {
  return nodeId.split(':').map(encodedPkgId => decodeURIComponent(encodedPkgId))
}

export const ROOT_NODE_ID = ':/:'
