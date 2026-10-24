import { createPrivateKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const API = 'https://api.appstoreconnect.apple.com/v1/'
const BUNDLE_ID = 'com.zergai.fakeidan'
const MAX_BYTES = 65_536

async function readAppleRecords(response) {
  if (!response.ok) throw new Error(`Apple distribution access denied (${response.status})`)
  if (!response.body) throw new Error('Apple returned no distribution response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('Apple distribution response exceeds the limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(result.data) || result.data.length > 10) throw new Error('Apple returned malformed distribution records')
  return result.data
}

export async function inspectAppleDistributionAccess({ issuer, keyId, privateKey, fetcher = fetch }) {
  if (!/^[0-9a-f-]{36}$/i.test(issuer) || !/^[A-Z0-9]{10}$/.test(keyId)) throw new Error('Invalid Apple API identity')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuer, iat: now, exp: now + 120, aud: 'appstoreconnect-v1' })}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  const request = { headers: { authorization: `Bearer ${unsigned}.${signature}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }
  const applications = await readAppleRecords(await fetcher(`${API}apps?filter%5BbundleId%5D=${BUNDLE_ID}&limit=10`, request))
  if (applications.some((app) => app.type !== 'apps' || !/^[0-9]{1,30}$/.test(app.id) || app.attributes?.bundleId !== BUNDLE_ID)) throw new Error('Apple returned an unexpected application')
  const bundles = await readAppleRecords(await fetcher(`${API}bundleIds?filter%5Bidentifier%5D=${BUNDLE_ID}&limit=10`, request))
  if (bundles.some((bundle) => bundle.type !== 'bundleIds' || !/^[A-Z0-9]{1,30}$/.test(bundle.id) || bundle.attributes?.identifier !== BUNDLE_ID)) throw new Error('Apple returned an unexpected bundle registration')
  return { available: true, applications: applications.map((app) => ({ id: app.id, bundleId: BUNDLE_ID })), bundleIds: bundles.map((bundle) => bundle.id) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv[2]
  if (!destination) throw new Error('Provide a private result path')
  const keyPath = process.env.APPLE_API_KEY_PATH
  const privateKey = keyPath ? await readFile(keyPath, 'utf8') : process.env.APPLE_API_PRIVATE_KEY
  try {
    const result = await inspectAppleDistributionAccess({ issuer: process.env.APPLE_API_ISSUER, keyId: process.env.APPLE_API_KEY_ID, privateKey })
    await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    console.log(`Apple distribution access checked: ${result.applications.length} matching apps; ${result.bundleIds.length} matching bundle registrations.`)
  } catch (error) {
    // Never write tokens, key material, or unbounded provider payloads to logs/artifacts.
    await writeFile(destination, `${JSON.stringify({ available: false, error: error.message.startsWith('Apple ') ? error.message : 'Apple distribution access check failed' })}\n`, { mode: 0o600 })
    console.error('Apple distribution access check failed; inspect the bounded result artifact.')
    process.exitCode = 1
  }
}
