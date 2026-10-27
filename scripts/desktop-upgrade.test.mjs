import assert from 'node:assert/strict';
import test from 'node:test';

import { UpgradeQualificationError, verifyUpgradeEvidence } from './desktop-upgrade.mjs';

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
]) {
  test(`does not qualify ${name}`, () => {
    const input = evidence(); mutate(input);
    assert.throws(() => verifyUpgradeEvidence(input), error => error instanceof UpgradeQualificationError && message.test(error.message));
  });
}
