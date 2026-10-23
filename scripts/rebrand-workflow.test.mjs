import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { makeReleaseNotes } from './release-notes.mjs';

const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
test('all artifact jobs receive one publisher-selected packaging profile from validation', () => {
  assert.equal(workflow.jobs.validate.outputs.product_name, '${{ steps.packaging.outputs.product_name }}');
  assert.equal(workflow.jobs.validate.steps.find(step => step.id === 'packaging')?.run, 'node scripts/release-packaging.mjs "${{ steps.request.outputs.version }}"');
  for (const name of ['build-macos', 'apple-sign', 'signed-smoke', 'sign-updater-preview', 'sign-updater-stable', 'sign-updater', 'publish']) {
    assert.equal(workflow.jobs[name].env.PACKAGING_ASSET_PREFIX, '${{ needs.validate.outputs.asset_prefix }}', name);
    assert.equal(workflow.jobs[name].env.PACKAGING_APP_BUNDLE, '${{ needs.validate.outputs.app_bundle }}', name);
  }
});
test('renamed release notes use the new visible product while historic notes retain their identity', () => {
  assert.match(makeReleaseNotes({ version:'0.2.0', channel:'stable', sourceSha:'a'.repeat(40) }), /^Zerg Bot 0\.2\.0/);
  assert.match(makeReleaseNotes({ version:'0.1.1', channel:'stable', sourceSha:'a'.repeat(40) }), /^FakeIdan 0\.1\.1/);
});

test('release creation and resume checks use the publisher-selected release name', () => {
  const publish = workflow.jobs.publish;
  assert.equal(publish.env.PACKAGING_RELEASE_NAME, '${{ needs.validate.outputs.release_name }}');
  const run = publish.steps.map(step => step.run ?? '').join('\n');
  assert.match(run, /--title "\$PACKAGING_RELEASE_NAME \$VERSION \(\$CHANNEL\)"/);
  assert.match(run, /release\.name !== process\.env\.PACKAGING_RELEASE_NAME \+/);
});

test('every credentialed or canonical archive extraction binds its version-selected root', () => {
  let calls = 0;
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      for (const match of (step.run ?? '').matchAll(/extractSourceApplication\(\{([\s\S]*?)\}\)/g)) {
        calls++;
        assert.match(match[1], /version: process\.env\.VERSION/, job.name);
      }
    }
  }
  assert.equal(calls, 2);
});
