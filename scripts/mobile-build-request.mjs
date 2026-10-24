import { pathToFileURL } from 'node:url'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
function code(version) {
  const match = typeof version === 'string' && version.match(VERSION)
  if (!match) throw new Error('Invalid mobile build request')
  const [major, minor, patch] = match.slice(1).map(Number)
  const result = major * 1_000_000 + minor * 1_000 + patch
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) throw new Error('Invalid mobile build request')
  return result
}
export function mobileBuildRequest(input) {
  if (!input || !/^[a-f0-9]{40}$/.test(input.sourceSha) || input.sourceRef !== `refs/tags/zergbot-mobile-v${input.version}` || code(input.upgradeVersion) <= code(input.version)) throw new Error('Invalid mobile build request')
  return { sourceSha: input.sourceSha, sourceRef: input.sourceRef, version: input.version, upgradeVersion: input.upgradeVersion }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request = mobileBuildRequest({ sourceSha: process.env.SOURCE_SHA, sourceRef: process.env.SOURCE_REF, version: process.env.VERSION, upgradeVersion: process.env.UPGRADE_VERSION })
  console.log(JSON.stringify(request))
}
