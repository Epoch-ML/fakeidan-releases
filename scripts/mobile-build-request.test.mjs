import assert from 'node:assert/strict'
import test from 'node:test'
import { mobileBuildRequest } from './mobile-build-request.mjs'
const request = { sourceSha: 'a'.repeat(40), sourceRef: 'refs/tags/zergbot-mobile-v0.3.0', version: '0.3.0', upgradeVersion: '0.3.1' }
test('binds qualification to an immutable source tag and increasing Android versions', () => {
  assert.deepEqual(mobileBuildRequest(request), request)
})
test('rejects mutable refs, shell fragments, noncanonical SHAs and nonincreasing versions', () => {
  for (const value of [
    { ...request, sourceRef: 'refs/heads/main' },
    { ...request, sourceRef: 'refs/tags/zergbot-mobile-v0.3.1' },
    { ...request, sourceSha: 'A'.repeat(40) },
    { ...request, version: '0.3.0; echo unsafe' },
    { ...request, upgradeVersion: '0.3.0' },
    { ...request, upgradeVersion: '0.2.9' },
  ]) assert.throws(() => mobileBuildRequest(value), /Invalid mobile build request/)
})
