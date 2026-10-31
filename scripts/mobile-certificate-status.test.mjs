import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

const workflow = parse(await readFile(new URL('../.github/workflows/mobile-build.yml', import.meta.url), 'utf8'))
const androidBuild = workflow.jobs.build.steps.find(step => step.name === 'Build unsigned Android A and B').run
const publicCertificate = await readFile(new URL('../keys/zergbot-android-signing.sha256', import.meta.url), 'utf8')

async function runAndroidCertificateStep({ certificate = 'file', trFailure = false, contents = publicCertificate } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zergbot-certificate-status-'))
  try {
    const tools = path.join(directory, 'bin')
    const pin = path.join(directory, 'release-repository/keys/zergbot-android-signing.sha256')
    const sdk = path.join(directory, 'android-sdk-fixture')
    const receiptFile = path.join(directory, 'native-build-receipts.jsonl')
    await mkdir(tools)
    await mkdir(path.dirname(pin), { recursive: true })
    // Filesystem fixtures replace SDK/source/certificate dependencies; no real SDK is run.
    await mkdir(path.join(sdk, 'ndk/28.2.13676358'), { recursive: true })
    if (certificate === 'file') await writeFile(pin, contents)
    else if (certificate === 'directory') await mkdir(pin)
    const rustup = path.join(tools, 'rustup')
    const node = path.join(tools, 'node')
    // Subprocess fakes keep target installation/builds offline; outputs reflect real script arguments/env.
    await writeFile(rustup, '#!/bin/sh\nexit 0\n')
    await writeFile(node, `#!${process.execPath}
import { appendFile } from 'node:fs/promises'
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
const certificate = process.env.ZERGBOT_ANDROID_CERT_SHA256 ?? null
await appendFile(process.env.CERTIFICATE_WORKFLOW_RECEIPTS, JSON.stringify({ version: value('--version'), sourceSha: value('--source-sha'), certificate }) + '\\n')
`)
    await chmod(rustup, 0o755)
    await chmod(node, 0o755)
    if (trFailure) {
      // tr is a separate process boundary; model a read/process failure without changing the YAML.
      const tr = path.join(tools, 'tr')
      await writeFile(tr, '#!/bin/sh\nprintf "%s\\n" "fixture certificate read failed" >&2\nexit 47\n')
      await chmod(tr, 0o755)
    }
    const result = spawnSync('/bin/bash', ['-c', androidBuild], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${tools}:/usr/bin:/bin`,
        JAVA_HOME_17_X64: path.join(directory, 'jdk-fixture'),
        ANDROID_SDK_ROOT: sdk,
        GITHUB_WORKSPACE: directory,
        SOURCE_APP_DIR: "source/zapps/zergbot",
        SOURCE_SHA: 'a'.repeat(40),
        VERSION: '0.3.4',
        UPGRADE_VERSION: '0.3.5',
        CERTIFICATE_WORKFLOW_RECEIPTS: receiptFile,
      },
    })
    let receipts = []
    try { receipts = (await readFile(receiptFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { status: result.status, stderr: result.stderr, receipts }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('real public certificate is propagated to both native build versions', async () => {
  const result = await runAndroidCertificateStep()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.receipts, [
    { version: '0.3.4', sourceSha: 'a'.repeat(40), certificate: publicCertificate.trim() },
    { version: '0.3.5', sourceSha: 'a'.repeat(40), certificate: publicCertificate.trim() },
  ])
})

test('CRLF certificate formatting is normalized before exporting to build children', async () => {
  const result = await runAndroidCertificateStep({ contents: publicCertificate.trim() + '\r\n' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.receipts.map(receipt => receipt.certificate), [publicCertificate.trim(), publicCertificate.trim()])
})

test('a failed certificate-reading process stops the actual workflow before native build', async () => {
  const result = await runAndroidCertificateStep({ trFailure: true })
  assert.equal(result.status, 47, 'certificate read failure must preserve its exit status')
  assert.deepEqual(result.receipts, [], 'no native build may start after certificate read failure')
})

test('a missing certificate file stops before native build', async () => {
  const result = await runAndroidCertificateStep({ certificate: 'missing' })
  assert.equal(result.status, 1, 'missing certificate input must stop the workflow')
  assert.deepEqual(result.receipts, [])
})

test('an invalid directory in place of the certificate file stops before native build', async () => {
  const result = await runAndroidCertificateStep({ certificate: 'directory' })
  assert.equal(result.status, 1, 'unreadable certificate input must stop the workflow')
  assert.deepEqual(result.receipts, [])
})
