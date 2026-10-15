#!/usr/bin/env node
/** Release closure for the platforms this distribution declares. No downloads, credentials or publish side effects. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLATFORMS } from '../lib/ptc/runtime.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if(JSON.stringify(pkg.os)!=='["win32","darwin"]'||JSON.stringify(pkg.cpu)!=='["x64","arm64"]')throw Error('Release scope must be Windows x64 + macOS arm64')
const runtimes=path.join(root,'runtime')
const targets=fs.existsSync(runtimes)?fs.readdirSync(runtimes,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name):[]
const allowed=new Set(PLATFORMS)
const unexpected=targets.filter(name=>!allowed.has(name))
if(unexpected.length>0)throw Error(`Unexpected runtime targets in release: ${unexpected.join(', ')}`)
// A source checkout stages only the host's worker; a published package carries
// every declared target. Either way the host must be able to run something.
const host=`${process.platform}-${process.arch}`
if(!targets.includes(host))throw Error(`Release is missing the host runtime target ${host}; stage it with bin/native-runtime.mjs`)
const check=spawnSync(process.execPath,[path.join(root,'bin/native-runtime.mjs'),'check','--platform',host],{stdio:'inherit'})
if(check.status!==0)throw Error('Native runtime gate failed')
// The MSYS IPC proxies exist for win32 only; validate them wherever they ship.
const ipc=path.join(runtimes,'win32-x64/bash-ipc')
if(fs.existsSync(ipc)){
  const receipt=JSON.parse(fs.readFileSync(path.join(ipc,'provenance.json'),'utf8'))
  if(receipt.version!==1||receipt.platform!=='win32-x64')throw Error('Invalid Bash IPC receipt')
  for(const name of ['opsipc.dll','opsnt.dll'])if(hash(path.join(ipc,name))!==receipt.files[name])throw Error(`IPC hash mismatch ${name}`)
  for(const name of ['security.h','opsipc.cpp','opsnt.cpp'])if(hash(path.join(root,'native/bash-ipc',name))!==receipt.sources[name])throw Error(`IPC source mismatch ${name}; rebuild proxies`)
  const actual=fs.readdirSync(ipc).sort()
  if(JSON.stringify(actual)!==JSON.stringify(['opsipc.dll','opsnt.dll','provenance.json']))throw Error('Unexpected Bash IPC output files')
}
console.log(`Release closure OK: dsh-ops@${pkg.version}, targets ${targets.sort().join(', ')}${fs.existsSync(ipc)?' + Bash IPC proxies':''}.`)
