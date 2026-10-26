import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const checksum = '4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806';
async function exercise({ corrupt = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bot-pinned-xcodegen-'));
  try {
    const bin = join(directory, 'bin'), runner = join(directory, 'runner');
    await mkdir(bin); await mkdir(runner);
    const githubPath = join(directory, 'github-path'), githubEnv = join(directory, 'github-env');
    await writeFile(githubPath, ''); await writeFile(githubEnv, '');
    // curl models only the HTTP process boundary, including fixed official URL and TLS options.
    await writeFile(join(bin, 'curl'), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(!args.includes('https://github.com/yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip')||!args.includes('--fail')||!args.includes('--location')||!args.includes('--proto')||!args.includes('=https')||!args.includes('--tlsv1.2'))process.exit(31);
const index=args.indexOf('--output');if(index<0)process.exit(32);
writeFileSync(args[index+1], 'fixture trusted-tool archive');
`);
    // shasum models the checksum subprocess: mismatched bytes fail before publication.
    await writeFile(join(bin, 'shasum'), `#!${process.execPath}
import {readFileSync} from 'node:fs';
const input=readFileSync(0,'utf8');
if(!input.startsWith(${JSON.stringify(checksum)}+'  ')||!input.includes('xcodegen-2.46.0.zip'))process.exit(33);
if(process.env.CORRUPT_TOOL==='true'){console.error('pinned XcodeGen checksum mismatch');process.exit(42);}
`);
    // unzip models only verified-package filesystem extraction, not the workflow under test.
    await writeFile(join(bin, 'unzip'), `#!${process.execPath}
import {mkdirSync,writeFileSync} from 'node:fs';import{join}from'node:path';
const args=process.argv.slice(2),target=args[args.indexOf('-d')+1];
mkdirSync(join(target,'xcodegen/bin'),{recursive:true});
writeFileSync(join(target,'xcodegen/bin/xcodegen'),'#!/bin/sh\\nprintf "%s\\n" "Version: 2.46.0"\\n',{mode:0o755});
`);
    for (const name of ['curl', 'shasum', 'unzip']) await chmod(join(bin, name), 0o755);
    const program = workflow.jobs['build-macos'].steps.filter(step => step.name === 'Install pinned XcodeGen for source release tests').map(step => step.run).join('\n');
    const result = spawnSync('bash', ['-c', program], { cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, GITHUB_PATH: githubPath, GITHUB_ENV: githubEnv, CORRUPT_TOOL: String(corrupt) } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      paths: (await readFile(githubPath, 'utf8')).split('\n').filter(Boolean),
      environment: (await readFile(githubEnv, 'utf8')).split('\n').filter(Boolean),
      expectedBin: join(runner, 'xcodegen-2.46.0/xcodegen/bin') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('pinned XcodeGen bootstrap publishes the runner-owned binary path and portable explicit selector', async () => {
  const result = await exercise();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.paths, [result.expectedBin]);
  assert.deepEqual(result.environment, [`ZERGBOT_XCODEGEN=${join(result.expectedBin, 'xcodegen')}`]);
});
test('a checksum mismatch stops before exposing any XcodeGen executable to source tests', async () => {
  const result = await exercise({ corrupt: true });
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /pinned XcodeGen checksum mismatch/);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.environment, []);
});
