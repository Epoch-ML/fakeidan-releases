import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import { inspectAppleDistributionAccess } from './mobile-apple-access.mjs'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const credentials = { issuer: '00000000-0000-4000-8000-000000000001', keyId: 'ABCDEFGHIJ', privateKey }

test('reports matching Apple application and registered bundle without exposing API credentials', async () => {
  const result = await inspectAppleDistributionAccess({ ...credentials, fetcher: async (url) => new Response(JSON.stringify({ data: url.includes('/apps?') ? [{ id: '123456789', type: 'apps', attributes: { bundleId: 'com.zergai.fakeidan', name: 'Zerg Bot' } }] : [{ id: 'BUNDLE123', type: 'bundleIds', attributes: { identifier: 'com.zergai.fakeidan' } }] })) })
  assert.deepEqual(result, { available: true, applications: [{ id: '123456789', bundleId: 'com.zergai.fakeidan' }], bundleIds: ['BUNDLE123'] })
  assert.equal(JSON.stringify(result).includes('ABCDEFGHIJ'), false)
})

test('distinguishes missing application setup from authentication denial', async () => {
  const missing = await inspectAppleDistributionAccess({ ...credentials, fetcher: async () => new Response(JSON.stringify({ data: [] })) })
  assert.deepEqual(missing, { available: true, applications: [], bundleIds: [] })
  await assert.rejects(inspectAppleDistributionAccess({ ...credentials, fetcher: async () => new Response('denied', { status: 403 }) }), /Apple distribution access denied \(403\)/)
})

test('rejects mismatched or malformed Apple records rather than implying release readiness', async () => {
  await assert.rejects(inspectAppleDistributionAccess({ ...credentials, fetcher: async () => new Response(JSON.stringify({ data: [{ id: '123', type: 'apps', attributes: { bundleId: 'attacker.other' } }] })) }), /Apple returned an unexpected application/)
})
