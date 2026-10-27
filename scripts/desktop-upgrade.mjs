#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const sourceVersion = '0.2.2';
const targetVersion = '0.3.2';
const bundleId = 'com.zergai.fakeidan';
const stableFeed = 'https://epoch-ml.github.io/fakeidan-releases/stable/latest.json';
const feedSha256 = '6aea75064ff82a1315902272e25945fb7d06b445cc2647af62ca3532f3971c62';
const artifacts = {
  [sourceVersion]: { bytes: 5585863, sha256: '4bdbff37d7e861174b77133c77fe8b3ef5fdbb2a1b1099e015dad0939262b9a1', signatureBytes: 424, signatureSha256: '33263dcf3b8f9e17555ea3e1dfe5c2c73d5c9b6e5647e8d9b6599a84cedd4149' },
  [targetVersion]: { bytes: 5672242, sha256: '6bb3b139c9467d1cc5d9bdfbcf78ee4857a39e742fe67fdbd9c8be96e23915df', signatureBytes: 424, signatureSha256: '593f59cf56f308827b785cc0504bb8958c7ef051f2db16b46077e1d93969634c' },
};

export class UpgradeQualificationError extends Error {}

function requireProof(condition, message) {
  if (!condition) throw new UpgradeQualificationError(message);
}

export function verifyUpgradeEvidence(evidence) {
  requireProof(evidence?.before?.version === sourceVersion, 'The source version must be public0.2.2.');
  requireProof(evidence?.expected?.version === targetVersion && evidence?.expected?.bundleId === bundleId, 'Unexpected target identity.');
  const entries = evidence.expected.entries;
  requireProof(entries && Object.keys(entries).length >= 3 && entries['Contents/Info.plist'] && entries['Contents/MacOS/fakeidan'] && entries['Contents/_CodeSignature/CodeResources'], 'Complete signed bundle entries are required.');
  for (const [name, actual] of [['staged bundle', evidence.staged?.entries], ['restarted bundle', evidence.restarted?.entries]]) {
    try { assert.deepEqual(actual, entries); } catch { throw new UpgradeQualificationError(`The ${name} differs from the canonical public archive.`); }
  }
  requireProof(evidence.staged.version === targetVersion && evidence.staged.originalPidAlive === true, 'The original process must remain alive after the update is staged.');
  requireProof(Number.isSafeInteger(evidence.before.pid) && evidence.before.pid > 0 && Number.isSafeInteger(evidence.restarted?.pid) && evidence.restarted.pid > 0 && evidence.restarted.pid !== evidence.before.pid, 'A fresh target process is required.');
  requireProof(evidence.before.bundleId === bundleId && evidence.restarted.bundleId === bundleId && evidence.restarted.version === targetVersion, 'The restarted target identity differs.');
  requireProof(evidence.restarted.aliveAfterMs >= 8000, 'The target must remain alive for at least eight seconds.');
  requireProof(evidence.termination?.requested === true && evidence.termination.exited === true && evidence.termination.forced === false, 'A normal termination of the original process is required.');
  for (const [actual, expected, label] of [
    ['feedSha256', 'expectedFeedSha256', 'feed digest'],
    ['archiveSha256', 'expectedArchiveSha256', 'target archive digest'],
    ['originalArchiveSha256', 'expectedOriginalArchiveSha256', 'source archive digest'],
  ]) {
    requireProof(/^[a-f0-9]{64}$/.test(evidence.delivery?.[actual]) && evidence.delivery[actual] === evidence.delivery[expected], `The public ${label} differs.`);
  }
  for (const proof of ['signatureVerified', 'originalSignatureVerified', 'sourceSignatureVerified', 'targetSignatureVerified']) requireProof(evidence.delivery[proof] === true, 'Every updater and code signature must be verified.');
  requireProof(evidence.independence?.runtime === 'tauri-public-signed-application' && evidence.independence.resigned === false, 'Only an unmodified signed public application qualifies.');
  requireProof(evidence.independence.downloadActionInvoked === false && evidence.independence.installActionInvoked === false, 'Only automatic download and installation qualify.');
  requireProof(evidence.independence.runner === 'github-hosted-macos-15' && evidence.independence.userProfile === 'fresh-runner', 'Only an isolated runner with a fresh profile is admitted.');
  return { qualified: true, fromVersion: sourceVersion, toVersion: targetVersion, verifiedBundleEntries: Object.keys(entries).length };
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export async function downloadPinned(url, destination, expected, http = fetch) {
  requireProof(Number.isSafeInteger(expected.bytes) && expected.bytes > 0 && expected.bytes <= 32 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(expected.sha256), 'Invalid download byte or digest boundary.');
  let current = new URL(url);
  let response;
  for (let attempt = 0; attempt < 6; attempt++) {
    requireProof(current.protocol === 'https:' && !current.username && !current.password, 'Downloads require credential-free HTTPS.');
    response = await http(current.href, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      requireProof(location !== null, 'Download redirect has no location.');
      current = new URL(location, current);
      continue;
    }
    break;
  }
  requireProof(response?.status === 200 && response.body !== null, `Pinned download failed with HTTP${response?.status}.`);
  const temporary = `${destination}.partial`;
  const file = await open(temporary, 'wx', 0o600);
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      requireProof(bytes <= expected.bytes, 'Pinned download exceeds its exact byte boundary.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    const sha256 = hash.digest('hex');
    requireProof(bytes === expected.bytes && sha256 === expected.sha256, 'Pinned download byte count or SHA256 differs.');
    await file.close();
    await rename(temporary, destination);
    return { bytes, sha256 };
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function command(file, args, options = {}) {
  const result = await execute(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
  return result.stdout.trim();
}

async function bundleEntries(root) {
  const entries = {};
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const item = await lstat(path);
      const key = relative(root, path);
      if (item.isSymbolicLink()) entries[key] = { kind: 'symlink', target: await readlink(path) };
      else if (item.isDirectory()) { entries[key] = { kind: 'directory', mode: item.mode & 0o777 }; await visit(path); }
      else {
        requireProof(item.isFile() && item.size <= 32 * 1024 * 1024, 'Unexpected or oversized bundle entry.');
        entries[key] = { kind: 'file', mode: item.mode & 0o777, bytes: item.size, sha256: digest(await readFile(path)) };
      }
      requireProof(Object.keys(entries).length <= 1024, 'Bundle exceeds the qualification entry limit.');
    }
  }
  await visit(root);
  return entries;
}

async function version(app) { return command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]); }
async function identity(app) { return command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')]); }
function alive(child) { return child.exitCode === null && child.signalCode === null; }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function assertAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new UpgradeQualificationError(`The fresh runner already has application state at ${path}.`);
}

async function verifyCodeSignature(app, output) {
  const signature = await execute('/usr/bin/codesign', ['-dvvv', app], { encoding: 'utf8' });
  requireProof(signature.stderr.includes('Authority=Developer ID Application:') && signature.stderr.includes('flags=0x10000(runtime)'), 'Expected the original hardened Developer ID signature.');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  await command('/usr/bin/xcrun', ['stapler', 'validate', app]);
  const assessment = await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { encoding: 'utf8', timeout: 120_000 });
  requireProof(assessment.stderr.includes('source=Notarized Developer ID'), 'Gatekeeper did not admit the notarized public app.');
  await writeFile(output, signature.stderr + assessment.stderr);
}

async function terminateNormally(child, directory) {
  const swift = join(directory, 'normal-quit.swift');
  await writeFile(swift, 'import AppKit\nlet pid = pid_t(CommandLine.arguments[1])!\nguard let app = NSRunningApplication(processIdentifier: pid), app.terminate() else { exit(2) }\nprint("normal termination requested")\n');
  await command('/usr/bin/swift', [swift, String(child.pid)], { timeout: 60_000 });
  for (let i = 0; i < 30; i++) { if (!alive(child)) return { requested: true, exited: true, forced: false }; await delay(1000); }
  throw new UpgradeQualificationError('The normal termination request did not finish within thirty seconds.');
}

export async function runPublicUpgrade(reportPath) {
  requireProof(process.platform === 'darwin' && process.arch === 'arm64' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'macOS', 'Only a fresh GitHub-hosted Apple Silicon macOS runner is admitted.');
  const temporaryRoot = resolve(process.env.RUNNER_TEMP || '');
  requireProof(isAbsolute(reportPath) && resolve(reportPath).startsWith(`${temporaryRoot}${sep}`), 'The report must remain inside RUNNER_TEMP.');
  const home = process.env.HOME;
  requireProof(typeof home === 'string' && isAbsolute(home), 'The runner home must be explicit.');
  for (const path of [join(home, 'Library/WebKit', bundleId), join(home, 'Library/Application Support', bundleId), '/tmp/com_zergai_fakeidan_si.sock']) await assertAbsent(path);
  const directory = await mkdtemp(join(temporaryRoot, 'zergbot-public-upgrade-'));
  const report = { schemaVersion: 1, qualified: false, startedAt: new Date().toISOString(), directory, platform: process.platform, architecture: process.arch, publicFromVersion: sourceVersion, publicToVersion: targetVersion, progress: [] };
  let source, target;
  let log;
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const record = async stage => { report.progress.push({ stage, at: new Date().toISOString() }); await save(); };
  try {
    await record('fresh-runner-admitted');
    const { extractSourceApplication } = await import('./package-macos.mjs');
    const minisignZip = join(directory, 'minisign.zip');
    await downloadPinned('https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-macos.zip', minisignZip, { bytes: 83496, sha256: '89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63' });
    const verifier = join(directory, 'minisign');
    const binary = await execute('/usr/bin/unzip', ['-p', minisignZip, 'minisign'], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    await writeFile(verifier, binary.stdout, { mode: 0o755 });
    const publicKey = (await readFile(new URL('../keys/fakeidan-stable-updater.pubkey', import.meta.url), 'utf8')).trim();
    requireProof(digest(Buffer.from(publicKey)) === 'a17220c476b10bab4c8813a8d121b5a502856f4dd15dfa683f17a3ff02a95b14', 'The independent stable updater root changed.');
    const decodedKey = join(directory, 'stable.pub');
    await writeFile(decodedKey, Buffer.from(publicKey, 'base64'));
    const apps = {};
    for (const selectedVersion of [sourceVersion, targetVersion]) {
      const name = `ZergBot_${selectedVersion}_aarch64.app.tar.gz`;
      const base = `https://github.com/Epoch-ML/fakeidan-releases/releases/download/fakeidan-v${selectedVersion}/`;
      const archive = join(directory, name), signature = `${archive}.sig`;
      const expected = artifacts[selectedVersion];
      await downloadPinned(base + name, archive, expected);
      await downloadPinned(`${base}${name}.sig`, signature, { bytes: expected.signatureBytes, sha256: expected.signatureSha256 });
      const decodedSignature = `${signature}.decoded`;
      await writeFile(decodedSignature, Buffer.from((await readFile(signature, 'utf8')).trim(), 'base64'));
      await command(verifier, ['-Vm', archive, '-p', decodedKey, '-x', decodedSignature]);
      const extracted = await extractSourceApplication({ archivePath: archive, outputDirectory: join(directory, selectedVersion), version: selectedVersion, maxArchiveBytes: 32 * 1024 * 1024, maxEntryCount: 1024, maxFileBytes: 32 * 1024 * 1024, maxUncompressedBytes: 64 * 1024 * 1024 });
      apps[selectedVersion] = extracted.applicationPath;
      requireProof(await version(extracted.applicationPath) === selectedVersion && await identity(extracted.applicationPath) === bundleId, 'The public archive bundle identity differs.');
      await verifyCodeSignature(extracted.applicationPath, join(directory, `signature-${selectedVersion}.log`));
    }
    const feedPath = join(directory, 'public-feed.json');
    await downloadPinned(stableFeed, feedPath, { bytes: 709, sha256: feedSha256 });
    const feed = JSON.parse(await readFile(feedPath, 'utf8'));
    requireProof(feed.version === targetVersion && feed.platforms['darwin-aarch64'].signature === (await readFile(join(directory, `ZergBot_${targetVersion}_aarch64.app.tar.gz.sig`), 'utf8')).trim(), 'The live stable feed does not identify the exact target.');
    const expectedEntries = await bundleEntries(apps[targetVersion]);
    await record('both-public-signed-bundles-and-live-feed-verified');
    log = createWriteStream(join(directory, 'public-native-process.log'), { mode: 0o600 });
    const launch = app => {
      const child = spawn(join(app, 'Contents/MacOS/fakeidan'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
      let bytes = 0;
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) log.write(chunk); });
      child.on('error', error => { report.processError = error.message; });
      return child;
    };
    source = launch(apps[sourceVersion]);
    report.before = { version: sourceVersion, pid: source.pid, bundleId };
    await record('unmodified-public-source-launched-no-download-or-install-action');
    let stagedVersion = sourceVersion;
    for (let i = 0; i < 180; i++) {
      requireProof(alive(source), 'The original public source process ended before staging.');
      try { stagedVersion = await version(apps[sourceVersion]); } catch (error) { report.lastStagingRead = error.message.slice(0, 512); }
      if (stagedVersion === targetVersion) break;
      await delay(1000);
    }
    requireProof(stagedVersion === targetVersion, 'Automatic public HTTPS update did not stage the target within three minutes.');
    // The installer can write Info.plist before all files. Wait for the complete signed bundle.
    let stagedEntries;
    for (let i = 0; i < 30; i++) {
      try { stagedEntries = await bundleEntries(apps[sourceVersion]); assert.deepEqual(stagedEntries, expectedEntries); break; } catch { await delay(1000); }
    }
    assert.deepEqual(stagedEntries, expectedEntries, 'The automatically installed bundle must equal the complete public target.');
    await verifyCodeSignature(apps[sourceVersion], join(directory, 'signature-automatically-staged.log'));
    report.staged = { version: stagedVersion, originalPidAlive: alive(source), entries: stagedEntries };
    requireProof(report.staged.originalPidAlive, 'The original process did not survive staging.');
    await record('actual-native-HTTPS-updater-installed-exact-target-original-process-alive');
    report.termination = await terminateNormally(source, directory);
    await record('source-quit-through-normal-NSRunningApplication-termination');
    target = launch(apps[sourceVersion]);
    const launchAt = performance.now();
    await delay(8000);
    requireProof(alive(target), 'The restarted public target process ended during eight-second launch observation.');
    report.restarted = { version: await version(apps[sourceVersion]), pid: target.pid, bundleId: await identity(apps[sourceVersion]), entries: await bundleEntries(apps[sourceVersion]), aliveAfterMs: Math.floor(performance.now() - launchAt) };
    report.expected = { version: targetVersion, bundleId, entries: expectedEntries };
    report.delivery = { feedSha256, expectedFeedSha256: feedSha256, archiveSha256: artifacts[targetVersion].sha256, expectedArchiveSha256: artifacts[targetVersion].sha256, originalArchiveSha256: artifacts[sourceVersion].sha256, expectedOriginalArchiveSha256: artifacts[sourceVersion].sha256, signatureVerified: true, originalSignatureVerified: true, sourceSignatureVerified: true, targetSignatureVerified: true };
    report.independence = { runtime: 'tauri-public-signed-application', resigned: false, downloadActionInvoked: false, installActionInvoked: false, runner: 'github-hosted-macos-15', userProfile: 'fresh-runner' };
    Object.assign(report, verifyUpgradeEvidence(report));
    report.restartMechanism = 'Normal NSRunningApplication quit followed by a fresh native launch; no in-app Restart button claim.';
    report.signedInSessionPreservationTested = false;
    await record('public-native-upgrade-qualified');
    return report;
  } catch (error) {
    report.qualified = false;
    report.error = { name: error.name, message: error.message.slice(0, 4096) };
    await save();
    throw error;
  } finally {
    for (const child of [target, source]) {
      if (child && alive(child)) {
        try { await terminateNormally(child, directory); } catch { child.kill('SIGTERM'); }
      }
    }
    if (log) await new Promise(resolveLog => log.end(resolveLog));
    report.finishedAt = new Date().toISOString();
    await save();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) { console.error('Usage: desktop-upgrade.mjs ABSOLUTE_RUNNER_TEMP_REPORT.json'); process.exitCode = 1; }
  else runPublicUpgrade(process.argv[2]).then(result => console.log(JSON.stringify({ qualified: result.qualified, fromVersion: result.fromVersion, toVersion: result.toVersion }))).catch(error => { console.error(`Public native upgrade: ${error.message}`); process.exitCode = 1; });
}
