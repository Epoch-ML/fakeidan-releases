import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const workflows=await Promise.all(['release','mobile-build'].map(async name=>({name,document:parse(await readFile(join(repository,'.github/workflows',name+'.yml'),'utf8'))})));
async function fixture(paths,exercise){
 const root=await mkdtemp(join(tmpdir(),'zergbot-source-root-'));
 try{
  await mkdir(join(root,'source/zapps'),{recursive:true});
  for(const name of paths){await mkdir(join(root,'source/zapps',name));for(const file of['package.json','package-lock.json'])await writeFile(join(root,'source/zapps',name,file),'{}');}
  await exercise(root);
 }finally{await rm(root,{recursive:true,force:true});}
}
async function select(root,workflow){
 const job=Object.values(workflow.document.jobs).find(job=>job.steps?.some(step=>step.name==='Resolve the immutable source app directory'));
 assert.ok(job,'the trusted workflow must resolve the renamed source app directory after checkout');
 const step=job.steps.find(step=>step.name==='Resolve the immutable source app directory');
 await mkdir(join(root,'release-repository/scripts'),{recursive:true});
 await copyFile(join(repository,'scripts/source-app-path.mjs'),join(root,'release-repository/scripts/source-app-path.mjs'));
 return spawnSync('bash',['-euo','pipefail','-c',step.run],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,GITHUB_ENV:join(root,'selected.env')}});
}
for(const workflow of workflows){
 for(const name of['zergbot','fakeidan'])test(`${workflow.name} resolves the ${name} source root without changing release identity`,async()=>fixture([name],async root=>{
  const result=await select(root,workflow);assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(root,'selected.env'),'utf8'),`SOURCE_APP_DIR=source/zapps/${name}\n`);
 }));
 for(const paths of[[],['zergbot','fakeidan']])test(`${workflow.name} refuses ${paths.length?'ambiguous':'missing'} app roots`,async()=>fixture(paths,async root=>{
  const result=await select(root,workflow);assert.notEqual(result.status,0);assert.match(result.stderr,/Exactly one supported source app directory/);
 }));
}
for(const target of['source','source/zapps','source/zapps/zergbot','source/zapps/zergbot/package-lock.json','source/zapps/zergbot/package.json'])test(`source selection refuses the symlink ${target}`,async()=>fixture(['zergbot'],async root=>{
 const original=join(root,target),outside=join(root,'replacement');
 const {rename}=await import('node:fs/promises');await rename(original,outside);await symlink(outside,original);
 const result=await select(root,workflows[0]);assert.notEqual(result.status,0);assert.match(result.stderr,target.endsWith('.json')?/must be a real file/:/must be a real directory/);
}));

for(const workflow of workflows)test(`${workflow.name} resolves from trusted public code after key cleanup and before every app path consumer`,()=>{
 const job=Object.values(workflow.document.jobs).find(job=>job.steps?.some(step=>step.name==='Resolve the immutable source app directory'));
 const select=job.steps.findIndex(step=>step.name==='Resolve the immutable source app directory');
 const cleanup=job.steps.findIndex(step=>step.name==='Delete ephemeral source deploy key');
 assert.ok(select>cleanup&&cleanup>=0);
 for(const [index,step]of job.steps.entries())if(JSON.stringify(step).includes('SOURCE_APP_DIR'))assert.ok(index>select,`path consumed before resolution: ${step.name??step.uses}`);
 assert.doesNotMatch(JSON.stringify(job),/source\/zapps\/(?:fakeidan|zergbot)/);
 assert.match(job.steps[select].run,/node release-repository\/scripts\/source-app-path\.mjs/);
});

test('importing the reusable source resolver has no CLI output or environment side effect',async()=>fixture(['zergbot'],async root=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('./source-app-path.mjs',import.meta.url).href)})`],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
}));

test('an unreadable alternate root cannot silently select the remaining candidate',async()=>fixture(['zergbot'],async root=>{
 const {resolveSourceAppDirectory}=await import('./source-app-path.mjs');
 const {lstat}=await import('node:fs/promises');
 // Only the filesystem process boundary fails; resolution and its real sibling root remain unmodified.
 const inspect=async path=>{if(path===join(root,'source/zapps/fakeidan'))throw Object.assign(new Error('disk unavailable'),{code:'EIO'});return lstat(path);};
 await assert.rejects(resolveSourceAppDirectory(join(root,'source'),inspect),{code:'EIO',message:'disk unavailable'});
}));
