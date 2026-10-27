import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {parse} from 'yaml';
const workflow=parse(await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'));
async function exercise(failFetch=false){
 const root=await mkdtemp(join(tmpdir(),'bot-cold-native-fixtures-'));
 try{
  const bin=join(root,'bin'),registry=join(root,'locked-registry-closure');await mkdir(bin);
  // Cargo is an external package/process boundary. A cold registry becomes complete
  // only after the committed manifest is fetched with lock enforcement.
  await writeFile(join(bin,'cargo'),`#!${process.execPath}
import{writeFileSync}from'node:fs';
const a=process.argv.slice(2);
if(a[0]==='fetch'){
 if(!a.includes('--locked')||a[a.indexOf('--manifest-path')+1]!=='source/zapps/fakeidan/src-tauri/Cargo.toml')process.exit(33);
 if(process.env.FAIL_FETCH==='true'){console.error('locked registry dependency unavailable');process.exit(42);}
 writeFileSync(process.env.COLD_REGISTRY,'complete');
}
`);
  // npm models release-check process boundaries: offline source contracts must
  // observe a complete registry, while the remaining checks are successful.
  await writeFile(join(bin,'npm'),`#!${process.execPath}
import{existsSync}from'node:fs';
if(process.argv.includes('test:release')&&!existsSync(process.env.COLD_REGISTRY)){console.error('offline iOS graph lacks locked dependency');process.exit(71);}
if(process.argv.includes('test:release'))console.log('offline cross-platform source contract passed');
`);
  // The Mac scanner is another Node process boundary; this fixture does not
  // replace its implementation or assert calls inside it.
  await writeFile(join(bin,'node'),'#!/bin/sh\nexit 0\n');
  for(const name of['cargo','npm','node'])await chmod(join(bin,name),0o755);
  const steps=workflow.jobs['build-macos'].steps;
  const program=steps.filter(s=>['Fetch locked native dependency closure for offline source tests','Test and audit the exact source'].includes(s.name)).map(s=>s.run).join('\n');
  const result=spawnSync('bash',['-c',program],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,PATH:bin+':'+process.env.PATH,COLD_REGISTRY:registry,FAIL_FETCH:String(failFetch)}});
  return result;
 }finally{await rm(root,{recursive:true,force:true});}
}
test('a cold runner fetches the complete locked registry before offline cross-platform source contracts',async()=>{
 const r=await exercise();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/offline cross-platform source contract passed/);
});
test('a failed locked native fetch fails the release before source tests can claim success',async()=>{
 const r=await exercise(true);assert.equal(r.status,42,r.stderr);assert.match(r.stderr,/locked registry dependency unavailable/);assert.doesNotMatch(r.stdout,/offline cross-platform source contract passed/);
});
