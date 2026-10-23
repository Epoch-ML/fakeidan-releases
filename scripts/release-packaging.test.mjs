import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { releasePackaging } from './release-packaging.mjs';

const script = fileURLToPath(new URL('./release-packaging.mjs', import.meta.url));
const legacy = {
  productName: 'Fake Idan', releaseName: 'FakeIdan', applicationName: 'Fake Idan.app', assetPrefix: 'FakeIdan',
  sourceProductName: 'Fake Idan', desktopUrl: 'https://fakeidan.com/desktop',
};
const bridge = { ...legacy, sourceProductName: 'Zerg Bot', desktopUrl: 'https://bot.zergai.com/desktop' };
const renamed = { ...bridge, productName: 'Zerg Bot', releaseName: 'Zerg Bot', applicationName: 'Zerg Bot.app', assetPrefix: 'ZergBot' };

test('packaging changes at numeric release boundaries, including preview builds', () => {
  for (const [version, expected] of [
    ['0.0.9', legacy], ['0.1.1', legacy], ['0.1.2', bridge],
    ['0.1.2-preview.1', bridge], ['0.1.10', bridge],
    ['0.2.0', renamed], ['0.2.0-preview.1', renamed], ['0.10.0', renamed], ['1.0.0', renamed],
  ]) assert.deepEqual(releasePackaging(version), expected, version);
});

test('packaging rejects noncanonical and missing versions', () => {
  for (const version of [undefined, null, 2, '', 'v0.2.0', '0.2', '00.2.0', '0.2.0\n']) {
    assert.throws(() => releasePackaging(version), /packaging version must be canonical SemVer/);
  }
});

test('the trusted CLI writes only fixed profile fields and preserves previous GitHub outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packaging-cli-'));
  try {
    const output = join(root, 'output');
    await writeFile(output, 'previous=value\n');
    const result = spawnSync(process.execPath, [script, '0.2.0'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), renamed);
    assert.equal(result.stdout, JSON.stringify(renamed) + '\n');
    assert.equal(await readFile(output, 'utf8'), 'previous=value\nproduct_name=Zerg Bot\nrelease_name=Zerg Bot\napp_bundle=Zerg Bot.app\nasset_prefix=ZergBot\nsource_product_name=Zerg Bot\ndesktop_url=https://bot.zergai.com/desktop\n');
    const standalone = spawnSync(process.execPath, [script, '0.1.1'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    assert.equal(standalone.status, 0, standalone.stderr);
    assert.deepEqual(JSON.parse(standalone.stdout), legacy);
    const invalid = spawnSync(process.execPath, [script, '0.2.0', 'extra'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.split('\n').find(line => line.startsWith('Error:')), 'Error: usage: release-packaging.mjs VERSION');
    assert.equal(invalid.stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
