import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import fc from 'fast-check';
import { parse } from 'yaml';

import { UpgradeQualificationError, downloadPinned, verifyUpgradeEvidence } from './desktop-upgrade.mjs';

function evidence() {
  const entries = {
    'Contents/Info.plist': { kind: 'file', bytes: 100, mode: 420, sha256: 'a'.repeat(64) },
    'Contents/MacOS/fakeidan': { kind: 'file', bytes: 1000, mode: 493, sha256: 'b'.repeat(64) },
    'Contents/_CodeSignature/CodeResources': { kind: 'file', bytes: 400, mode: 420, sha256: 'c'.repeat(64) },
  };
  return {
    before: { version: '0.2.2', pid: 101, bundleId: 'com.zergai.fakeidan' },
    staged: { version: '0.3.2', originalPidAlive: true, entries: structuredClone(entries) },
    restarted: { version: '0.3.2', pid: 202, bundleId: 'com.zergai.fakeidan', entries: structuredClone(entries), aliveAfterMs: 8000 },
    expected: { version: '0.3.2', bundleId: 'com.zergai.fakeidan', entries },
    delivery: {
      feedSha256: 'd'.repeat(64), expectedFeedSha256: 'd'.repeat(64),
      archiveSha256: 'e'.repeat(64), expectedArchiveSha256: 'e'.repeat(64),
      originalArchiveSha256: 'f'.repeat(64), expectedOriginalArchiveSha256: 'f'.repeat(64),
      signatureVerified: true, originalSignatureVerified: true,
      sourceSignatureVerified: true, targetSignatureVerified: true,
    },
    termination: { requested: true, exited: true, forced: false },
    independence: {
      runtime: 'tauri-public-signed-application', resigned: false,
      downloadActionInvoked: false, installActionInvoked: false,
      runner: 'github-hosted-macos-15', userProfile: 'fresh-runner',
    },
  };
}

test('only a staged signed public update with a normal quit and fresh target process qualifies', () => {
  const result = verifyUpgradeEvidence(evidence());
  assert.equal(result.qualified, true);
  assert.equal(result.fromVersion, '0.2.2');
  assert.equal(result.toVersion, '0.3.2');
  assert.equal(result.verifiedBundleEntries, 3);
});

// Complete bundle equality is invariant under property insertion order.
test('bundle enumeration order does not change the qualification', () => {
  fc.assert(fc.property(fc.shuffledSubarray(Object.keys(evidence().expected.entries), { minLength: 3, maxLength: 3 }), order => {
    const input = evidence();
    input.staged.entries = Object.fromEntries(order.map(key => [key, input.staged.entries[key]]));
    assert.equal(verifyUpgradeEvidence(input).verifiedBundleEntries, 3);
  }));
});

for (const [name, mutate, message] of [
  ['fresh launch without an update', x => { x.before.version = '0.3.2'; }, /source version/],
  ['empty target bundle', x => { x.expected.entries = {}; x.staged.entries = {}; x.restarted.entries = {}; }, /bundle entries/],
  ['missing signed resource', x => { delete x.staged.entries['Contents/_CodeSignature/CodeResources']; }, /staged bundle/],
  ['plausible wrong executable', x => { x.staged.entries['Contents/MacOS/fakeidan'].sha256 = '9'.repeat(64); }, /staged bundle/],
  ['restarted different executable', x => { x.restarted.entries['Contents/MacOS/fakeidan'].sha256 = '9'.repeat(64); }, /restarted bundle/],
  ['old process ended before staging', x => { x.staged.originalPidAlive = false; }, /original process/],
  ['same process called a restart', x => { x.restarted.pid = x.before.pid; }, /fresh target process/],
  ['wrong target identity', x => { x.restarted.bundleId = 'other.app'; }, /target identity/],
  ['short lived target', x => { x.restarted.aliveAfterMs = 7999; }, /eight seconds/],
  ['forced quit', x => { x.termination.forced = true; }, /normal termination/],
  ['failed quit', x => { x.termination.exited = false; }, /normal termination/],
  ['unmatched public feed', x => { x.delivery.feedSha256 = '0'.repeat(64); }, /feed digest/],
  ['unmatched target archive', x => { x.delivery.archiveSha256 = '0'.repeat(64); }, /target archive digest/],
  ['unmatched source archive', x => { x.delivery.originalArchiveSha256 = '0'.repeat(64); }, /source archive digest/],
  ['bad updater signature', x => { x.delivery.signatureVerified = false; }, /signature/],
  ['bad original updater signature', x => { x.delivery.originalSignatureVerified = false; }, /signature/],
  ['bad source code signature', x => { x.delivery.sourceSignatureVerified = false; }, /signature/],
  ['bad target code signature', x => { x.delivery.targetSignatureVerified = false; }, /signature/],
  ['resigned fixture', x => { x.independence.resigned = true; }, /unmodified signed public/],
  ['manual download', x => { x.independence.downloadActionInvoked = true; }, /automatic download/],
  ['manual install', x => { x.independence.installActionInvoked = true; }, /automatic download/],
  ['user workstation', x => { x.independence.runner = 'local-mac'; }, /isolated runner/],
  ['existing user profile', x => { x.independence.userProfile = 'existing'; }, /isolated runner/],
  ['different runtime', x => { x.independence.runtime = 'simulated-updater'; }, /unmodified signed public/],
  ['unrequested termination', x => { x.termination.requested = false; }, /normal termination/],
  ['wrong expected target version', x => { x.expected.version = '0.3.1'; }, /target identity/],
  ['wrong expected target bundle', x => { x.expected.bundleId = 'other.app'; }, /target identity/],
  ['missing expected plist', x => { for (const item of [x.expected, x.staged, x.restarted]) delete item.entries['Contents/Info.plist']; }, /bundle entries/],
  ['missing expected executable', x => { for (const item of [x.expected, x.staged, x.restarted]) delete item.entries['Contents/MacOS/fakeidan']; }, /bundle entries/],
  ['missing expected signature', x => { for (const item of [x.expected, x.staged, x.restarted]) delete item.entries['Contents/_CodeSignature/CodeResources']; }, /bundle entries/],
  ['incorrect staged version', x => { x.staged.version = '0.2.2'; }, /original process/],
  ['source PID zero', x => { x.before.pid = 0; }, /fresh target process/],
  ['target PID zero', x => { x.restarted.pid = 0; }, /fresh target process/],
  ['source PID fractional', x => { x.before.pid = 1.5; }, /fresh target process/],
  ['target PID fractional', x => { x.restarted.pid = 2.5; }, /fresh target process/],
  ['wrong source identity', x => { x.before.bundleId = 'other.app'; }, /target identity/],
  ['wrong restarted version', x => { x.restarted.version = '0.2.2'; }, /target identity/],
  ['prefix added to feed digest', x => { x.delivery.feedSha256 = x.delivery.expectedFeedSha256 = `x${x.delivery.feedSha256}`; }, /feed digest/],
  ['suffix added to feed digest', x => { x.delivery.feedSha256 = x.delivery.expectedFeedSha256 = `${x.delivery.feedSha256}x`; }, /feed digest/],
]) {
  test(`does not qualify ${name}`, () => {
    const input = evidence(); mutate(input);
    assert.throws(() => verifyUpgradeEvidence(input), error => error instanceof UpgradeQualificationError && message.test(error.message));
  });
}

test('absent evidence fails with the specific source-version qualification error', () => {
  for (const value of [undefined, null, {}, { before: {} }]) assert.throws(() => verifyUpgradeEvidence(value), error => error instanceof UpgradeQualificationError && error.message.includes('source version'));
});

const bytes = Buffer.from('public signed fixture');
const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'zergbot-upgrade-download-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('a pinned streamed download persists only its verified bytes', async t => {
  const root = await directory(t);
  // HTTP is the only fake boundary; local file writes and digest calculation are real.
  const result = await downloadPinned('https://example.test/public', join(root, 'artifact'), expected, async () => new Response(bytes));
  assert.equal(result.sha256, expected.sha256);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(await readFile(join(root, 'artifact')), bytes);
  assert.deepEqual(await readdir(root), ['artifact']);
});

for (const [name, response, message] of [
  ['HTTP500', () => new Response('failed', { status: 500 }), /HTTP500/],
  ['truncated body', () => new Response(bytes.subarray(0, -1)), /SHA256 differs/],
  ['oversized body', () => new Response(Buffer.concat([bytes, Buffer.from('x')])), /byte boundary/],
  ['wrong same-size body', () => new Response(Buffer.alloc(bytes.length, 'x')), /SHA256 differs/],
  ['empty body', () => new Response(Buffer.alloc(0)), /SHA256 differs/],
  ['downgraded redirect', () => new Response(null, { status: 302, headers: { location: 'http://example.test/public' } }), /HTTPS/],
  ['missing redirect location', () => new Response(null, { status: 302 }), /no location/],
]) {
  test(`does not leave a successful artifact after ${name}`, async t => {
    const root = await directory(t);
    // HTTP failures are injected at the network boundary, not in sibling helpers.
    await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), expected, async () => response()), message);
    assert.deepEqual(await readdir(root), []);
  });
}

test('a network timeout propagates and leaves no artifact', async t => {
  const root = await directory(t);
  await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), expected, async () => { throw new DOMException('network timeout', 'TimeoutError'); }), { name: 'TimeoutError', message: 'network timeout' });
  assert.deepEqual(await readdir(root), []);
});

test('an HTTPS redirect can succeed without weakening the pinned digest', async t => {
  const root = await directory(t);
  const response = async url => url.endsWith('/public') ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/pinned' } }) : new Response(bytes);
  await downloadPinned('https://example.test/public', join(root, 'artifact'), expected, response);
  assert.deepEqual(await readFile(join(root, 'artifact')), bytes);
});

test('HTTP300 follows its explicit HTTPS location instead of silently failing the public handoff', async t => {
  const root = await directory(t);
  const response = async url => url.endsWith('/public') ? new Response(null, { status: 300, headers: { location: 'https://cdn.example.test/pinned' } }) : new Response(bytes);
  await downloadPinned('https://example.test/public', join(root, 'artifact'), expected, response);
  assert.deepEqual(await readFile(join(root, 'artifact')), bytes);
});

test('HTTP400 remains an HTTP error rather than being treated as a redirect', async t => {
  const root = await directory(t);
  await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), expected, async () => new Response(null, { status: 400 })), /HTTP400/);
  assert.deepEqual(await readdir(root), []);
});

test('the HTTP transport must retain manual redirects and a live timeout signal', async t => {
  const root = await directory(t);
  // Model a transport that refuses requests outside its required HTTPS/timeout contract.
  const transport = async (_url, options) => options.redirect === 'manual' && options.signal instanceof AbortSignal && !options.signal.aborted ? new Response(bytes) : new Response(null, { status: 500 });
  await downloadPinned('https://example.test/public', join(root, 'artifact'), expected, transport);
  assert.deepEqual(await readFile(join(root, 'artifact')), bytes);
});

test('six redirect responses exhaust the download budget even if a seventh would succeed', async t => {
  const root = await directory(t);
  let requests = 0;
  const response = async () => ++requests <= 6 ? new Response(null, { status: 302, headers: { location: 'https://example.test/again' } }) : new Response(bytes);
  await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), expected, response), /HTTP302/);
  assert.deepEqual(await readdir(root), []);
  assert.equal(requests, 6);
});

test('a correct body hash cannot hide a shorter-than-declared public download', async t => {
  const root = await directory(t);
  await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), { ...expected, bytes: expected.bytes + 1 }, async () => new Response(bytes)), /byte count or SHA256 differs/);
  assert.deepEqual(await readdir(root), []);
});

for (const value of [{ ...expected, bytes: 0 }, { ...expected, bytes: -1 }, { ...expected, bytes: 1.5 }, { ...expected, bytes: 32 * 1024 * 1024 + 1 }, { ...expected, sha256: `x${expected.sha256}` }, { ...expected, sha256: `${expected.sha256}x` }]) {
  test(`invalid pinned download bounds are rejected: ${JSON.stringify(value)}`, async t => {
    const root = await directory(t);
    await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), value, async () => new Response(bytes)), /Invalid download byte or digest boundary/);
    assert.deepEqual(await readdir(root), []);
  });
}

test('exactly32MiB is an admitted download boundary and HTTP failure still propagates', async t => {
  const root = await directory(t);
  await assert.rejects(downloadPinned('https://example.test/public', join(root, 'artifact'), { ...expected, bytes: 32 * 1024 * 1024 }, async () => new Response(null, { status: 500 })), /HTTP500/);
  assert.deepEqual(await readdir(root), []);
});

test('the executable refuses a user workstation before making any app or profile change', async t => {
  const root = await directory(t);
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('./desktop-upgrade.mjs', import.meta.url).pathname, join(root, 'report.json')], { env: { ...process.env, GITHUB_ACTIONS: 'false' } }), error => error.code === 1 && error.stderr.includes('Only a fresh GitHub-hosted Apple Silicon macOS runner'));
  assert.deepEqual(await readdir(root), []);
});

test('the isolated workflow admits no secret or signing environment and only pinned actions', async () => {
  const text = await readFile(new URL('../.github/workflows/desktop-public-upgrade.yml', import.meta.url), 'utf8');
  const workflow = parse(text);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  const job = workflow.jobs['public-native-upgrade'];
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job['timeout-minutes'], 15);
  assert.equal(job.environment, undefined);
  assert.equal(job.steps.some(step => step.run === 'node scripts/desktop-upgrade.mjs "$RUNNER_TEMP/zergbot-public-upgrade.json"'), true);
  assert.equal(text.includes('secrets.'), false);
  assert.equal(text.includes('signing_private'), false);
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
});
