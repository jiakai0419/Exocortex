#!/usr/bin/env node
// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'src/native/jpeg-validator.c');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
let prefix=process.env.EXOCORTEX_LIBJPEG_PREFIX, output=join(root,'build/native/jpeg-validator');
for(let index=0;index<args.length;index++) {
  const flag=args[index],value=args[++index];
  if(!['--libjpeg-prefix','--out'].includes(flag)||!value||!isAbsolute(value)) {
    process.stderr.write('Usage: build-jpeg-validator.mjs [--libjpeg-prefix ABSOLUTE_PATH] [--out ABSOLUTE_PATH]\n');process.exit(2);
  }
  if(flag==='--libjpeg-prefix')prefix=value;else output=value;
}
if(prefix!==undefined&&!isAbsolute(prefix)) {process.stderr.write('EXOCORTEX_LIBJPEG_PREFIX must be absolute.\n');process.exit(2);}
prefix ||= ['/opt/homebrew/opt/jpeg-turbo','/usr/local/opt/jpeg-turbo','/usr/local','/usr']
  .find(path=>existsSync(join(path,'lib/libjpeg.a'))&&existsSync(join(path,'include/jconfig.h')));
if(!prefix) {process.stderr.write('A previously installed libjpeg-turbo prefix is required; this tool never installs or downloads dependencies. Set EXOCORTEX_LIBJPEG_PREFIX.\n');process.exit(2);}
const archive=join(prefix,'lib/libjpeg.a'),include=join(prefix,'include'),temporary=`${output}.${randomUUID()}.tmp`;
const inputs=`${temporary}.inputs`,headerNames=['jpeglib.h','jconfig.h','jmorecfg.h','jerror.h'];
try {
  const headers=headerNames.map(name=>readFileSync(join(include,name)));
  const version=headers[1].toString('utf8').match(/^#define LIBJPEG_TURBO_VERSION\s+([0-9]+(?:\.[0-9]+){2,3})\s*$/m)?.[1];
  if(!version)throw new Error('The prefix must supply libjpeg-turbo headers and its matching static archive.');
  const sourceBytes=readFileSync(source),archiveBytes=readFileSync(archive),archiveHash=hash(archiveBytes);
  mkdirSync(dirname(output),{recursive:true});
  mkdirSync(inputs,{mode:0o700});
  headerNames.forEach((name,index)=>writeFileSync(join(inputs,name),headers[index],{mode:0o600}));
  writeFileSync(join(inputs,'jpeg-validator.c'),sourceBytes,{mode:0o600});
  writeFileSync(join(inputs,'libjpeg.a'),archiveBytes,{mode:0o600});
  const compiled=spawnSync(process.env.CC || 'cc',['-std=c11','-O2','-fstack-protector-strong','-Wall','-Wextra','-Werror',
    '-I',inputs,join(inputs,'jpeg-validator.c'),join(inputs,'libjpeg.a'),'-lm','-o',temporary],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(compiled.error||compiled.status!==0) {
    process.stderr.write(String(compiled.stderr||''));throw new Error('JPEG validator compilation failed.');
  }
  if(hash(readFileSync(source))!==hash(sourceBytes)||hash(readFileSync(archive))!==archiveHash
    ||headerNames.some((name,index)=>hash(readFileSync(join(include,name)))!==hash(headers[index])))
    throw new Error('JPEG validator build inputs changed during compilation.');
  const checked=spawnSync(temporary,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:8192});
  const identity=JSON.parse(checked.stdout||'null');
  if(checked.error||checked.status!==0||checked.stderr||identity?.version!==1
    ||identity.decoder!=='libjpeg-turbo'||identity.decoder_version!==version)throw new Error('JPEG validator identity check failed.');
  const receipt={version:1,protocol:'exocortex_jpeg_validator/v1',platform:process.platform,arch:process.arch,
    source_sha256:hash(sourceBytes),binary_sha256:hash(readFileSync(temporary)),decoder:'libjpeg-turbo',decoder_version:version,
    archive_sha256:archiveHash,headers_sha256:hash(Buffer.concat(headers))};
  const licenses=join(dirname(output),'libjpeg-turbo-licenses');mkdirSync(licenses,{recursive:true});
  for(const name of ['LICENSE.md','README.ijg'])copyFileSync(join(prefix,'share/doc/libjpeg-turbo',name),join(licenses,name));
  writeFileSync(`${temporary}.json`,JSON.stringify(receipt,null,2)+'\n',{mode:0o644});
  // Concurrent readers fail closed during publication; runtime never repairs a
  // missing/mismatched executable or receipt and never compiles in a read path.
  renameSync(temporary,output);renameSync(`${temporary}.json`,`${output}.json`);
  process.stdout.write(JSON.stringify({built:true,output,...receipt},null,2)+'\n');
} catch(error) {
  process.stderr.write(`${error instanceof Error?error.message:'JPEG validator build failed.'}\n`);process.exitCode=1;
} finally {rmSync(temporary,{force:true});rmSync(`${temporary}.json`,{force:true});rmSync(inputs,{recursive:true,force:true});}
