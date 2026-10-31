import {lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const supported=['zapps/zergbot','zapps/fakeidan'];
async function requireReal(path,kind,inspect){
 const stat=await inspect(path);
 if(kind==='directory'?!stat.isDirectory():!stat.isFile())throw new Error(`${path} must be a real ${kind}`);
}
/** Return a fixed repository-relative path, never a value read from source configuration. */
export async function resolveSourceAppDirectory(source='source',inspect=lstat){
 await requireReal(source,'directory',inspect);
 await requireReal(join(source,'zapps'),'directory',inspect);
 const present=[];
 for(const relative of supported){
  const directory=join(source,relative);
  try{await inspect(directory)}catch(error){if(error.code==='ENOENT')continue;throw error;}
  await requireReal(directory,'directory',inspect);
  await requireReal(join(directory,'package.json'),'file',inspect);
  await requireReal(join(directory,'package-lock.json'),'file',inspect);
  present.push(relative);
 }
 if(present.length!==1)throw new Error('Exactly one supported source app directory must be present.');
 return present[0];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(`SOURCE_APP_DIR=source/${await resolveSourceAppDirectory()}\n`);}
 catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
