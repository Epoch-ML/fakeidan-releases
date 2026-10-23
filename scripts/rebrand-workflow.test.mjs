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
