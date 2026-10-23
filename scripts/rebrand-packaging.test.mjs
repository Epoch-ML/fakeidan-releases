import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { packageMacApplication, extractSourceApplication } from './package-macos.mjs';
import { prepareSourceStage } from './source-stage.mjs';
import { collectSignedRelease } from './collect-release.mjs';
import { verifyReleasePayload } from './verify-release-payload.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sourceSha = 'a'.repeat(40);
const request = { version: '0.2.0', channel: 'stable', sourceSha, releaseTag: 'fakeidan-v0.2.0', requestedAt: '2026-10-23T00:00:00.000Z' };
const signature = Buffer.from('trusted test signature boundary '.repeat(5)).toString('base64');
async function fixture(appName = 'Zerg Bot.app') {
  const root = await mkdtemp(join(tmpdir(), 'zergbot-packaging-'));
  temporary.push(root);
  const applicationPath = join(root, appName);
  await mkdir(join(applicationPath, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(applicationPath, 'Contents/Info.plist'), 'bounded fixture plist');
  await writeFile(join(applicationPath, 'Contents/MacOS/fakeidan'), 'native fixture bytes');
  await chmod(join(applicationPath, 'Contents/MacOS/fakeidan'), 0o755);
  const inputDirectory = join(root, 'input');
  await mkdir(inputDirectory);
  const publicKeyPath = join(root, 'trusted.pubkey');
  await writeFile(publicKeyPath, 'trusted key\n');
  await writeFile(join(inputDirectory, 'updater.pubkey'), 'trusted key\n');
  return { root, applicationPath, inputDirectory, publicKeyPath };
}

test('0.2 source stage admits only its version-selected Zerg Bot archive and metadata', async () => {
  const f = await fixture();
  await packageMacApplication({ applicationPath: f.applicationPath, outputPath: join(f.inputDirectory, 'ZergBot_0.2.0_aarch64.source.app.tar.gz'), version: request.version });
  await writeFile(join(f.inputDirectory, 'build-metadata.json'), JSON.stringify({ schema_version: 2, product: 'Zerg Bot', version: request.version, channel: 'stable', release_tag: request.releaseTag, source_sha: sourceSha, platform: 'darwin-aarch64', apple_signature: 'none' }));
  const result = await prepareSourceStage({ ...f, request, outputDirectory: join(f.root, 'extracted') });
  assert.equal(result.applicationPath, join(f.root, 'extracted/Zerg Bot.app'));
  assert.equal(await readFile(join(result.applicationPath, 'Contents/MacOS/fakeidan'), 'utf8'), 'native fixture bytes');
});

test('a new-version extraction rejects a legacy root rather than admitting either product', async () => {
  const f = await fixture('Fake Idan.app');
  const archivePath = join(f.root, 'legacy.app.tar.gz');
  await packageMacApplication({ applicationPath: f.applicationPath, outputPath: archivePath });
  await assert.rejects(extractSourceApplication({ archivePath, outputDirectory: join(f.root, 'extracted'), version: request.version }), /Zerg Bot\.app/);
});

test('collector and canonical payload verification agree on new product names and immutable asset paths', async () => {
  const f = await fixture();
  const archive = 'ZergBot_0.2.0_aarch64.app.tar.gz';
  await packageMacApplication({ applicationPath: f.applicationPath, outputPath: join(f.inputDirectory, archive), version: request.version });
  await writeFile(join(f.inputDirectory, archive + '.sig'), signature + '\n');
  await writeFile(join(f.inputDirectory, 'ZergBot_0.2.0_aarch64.dmg'), 'notarized test fixture boundary');
  await writeFile(join(f.inputDirectory, 'build-metadata.json'), JSON.stringify({ schema_version: 1, product: 'Zerg Bot', version: request.version, channel: 'stable', release_tag: request.releaseTag, source_sha: sourceSha, platform: 'darwin-aarch64', apple_notarized: true }));
  const outputDirectory = join(f.root, 'release');
  const result = await collectSignedRelease({ ...f, request, outputDirectory, releaseRepository: 'Epoch-ML/fakeidan-releases' });
  assert.equal(result.manifest.platforms['darwin-aarch64'].url, 'https://github.com/Epoch-ML/fakeidan-releases/releases/download/fakeidan-v0.2.0/ZergBot_0.2.0_aarch64.app.tar.gz');
  const metadata = JSON.parse(await readFile(join(outputDirectory, 'release-metadata.json'), 'utf8'));
  assert.equal(metadata.product, 'Zerg Bot');
  const verification = await verifyReleasePayload({ directory: outputDirectory, request, releaseRepository: 'Epoch-ML/fakeidan-releases' });
  assert.equal(verification.archiveName, 'ZergBot_0.2.0_aarch64.app.tar.gz');
  assert.equal(verification.diskImageName, 'ZergBot_0.2.0_aarch64.dmg');
});
