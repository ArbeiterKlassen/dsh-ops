#!/usr/bin/env node
/** 发布闭合检查:声明的作用域、已 stage 的原生运行时、以及 Windows IPC 代理必须自洽。无下载、无凭据、无发布副作用。
 *
 * 作用域不再硬编码。期望目标集从 `package.json` 的 `os` × `cpu` 推导, 并要求它与
 * `lib/ptc/runtime.js` 的 PLATFORMS 完全一致——这正是「平台作用域要动五处」里最容易
 * 被漏掉的那一处, 现在由断言守住。
 *
 * 默认只闭合**本包实际携带的**目标, 因为 Linux 上无法产出 Windows 的 worker 与 MSVC
 * IPC 代理。要声明「发布包必须齐平台」, 设 `DSH_OPS_REQUIRE_ALL_TARGETS=1`; 届时每个
 * 已声明目标都必须在场, 且 win32-x64 的 Bash IPC 闭包也必须通过。这与仓库既有的
 * `DSH_OPS_REQUIRE_RUNTIME=1` 约定一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLATFORMS } from '../lib/ptc/runtime.js'
const { values } = parseArgs({ options: { root: { type: 'string' } } })
// `--root` 让同一套闭合逻辑作用于解包后的 tarball, 从而校验真正发布出去的产物,
// 而不只是它所在的 checkout。
const root = path.resolve(values.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
// 1. 声明的作用域必须支持, 且与解析器认的平台集合逐项相同。
const declared=(pkg.os??[]).flatMap(platform=>(pkg.cpu??[]).map(arch=>`${platform}-${arch}`))
const unsupported=declared.filter(target=>!PLATFORMS.includes(target))
if(unsupported.length)throw Error(`Declared scope names an unsupported target: ${unsupported.join(', ')}`)
if(JSON.stringify(declared)!==JSON.stringify([...PLATFORMS]))throw Error(`Declared scope ${JSON.stringify(declared)} and lib/ptc/runtime.js PLATFORMS ${JSON.stringify([...PLATFORMS])} disagree`)
// 2. 已 stage 的目标必须是声明集合的子集, 且不能为空。
const runtimeDir=path.join(root,'runtime')
const staged=fs.existsSync(runtimeDir)?fs.readdirSync(runtimeDir,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort():[]
const unexpected=staged.filter(target=>!declared.includes(target))
if(unexpected.length)throw Error(`Unexpected runtime targets in release: ${unexpected.join(', ')}`)
if(staged.length===0)throw Error('No staged native runtime in this package; there is nothing to release')
const requireAll=process.env.DSH_OPS_REQUIRE_ALL_TARGETS==='1'
const missing=declared.filter(target=>!staged.includes(target))
if(requireAll&&missing.length)throw Error(`DSH_OPS_REQUIRE_ALL_TARGETS=1 but this package is missing ${missing.join(', ')}; a release must carry every declared target`)
// 3. 逐个校验在场目标的摘要与二进制格式, 不碰缺场的那些。
const check=spawnSync(process.execPath,[path.join(root,'bin/native-runtime.mjs'),'check','--staged','--root',root],{stdio:'inherit'})
if(check.status!==0)throw Error('Native runtime gate failed')
// 4. Bash IPC 代理是 win32-x64 独有的产物, 因此只在它确实在场时闭合。
let ipcNote
if(staged.includes('win32-x64')){
  const ipc=path.join(root,'runtime/win32-x64/bash-ipc')
  const receipt=JSON.parse(fs.readFileSync(path.join(ipc,'provenance.json'),'utf8'))
  if(receipt.version!==1||receipt.platform!=='win32-x64')throw Error('Invalid Bash IPC receipt')
  for(const name of ['opsipc.dll','opsnt.dll'])if(hash(path.join(ipc,name))!==receipt.files[name])throw Error(`IPC hash mismatch ${name}`)
  for(const name of ['security.h','opsipc.cpp','opsnt.cpp'])if(hash(path.join(root,'native/bash-ipc',name))!==receipt.sources[name])throw Error(`IPC source mismatch ${name}; rebuild proxies`)
  const actual=fs.readdirSync(ipc).sort()
  if(JSON.stringify(actual)!==JSON.stringify(['opsipc.dll','opsnt.dll','provenance.json']))throw Error('Unexpected Bash IPC output files')
  ipcNote=' + Bash IPC proxies + matching source'
}else{
  ipcNote=' (Bash IPC closure skipped: win32-x64 is not staged; DSH_OPS_REQUIRE_ALL_TARGETS=1 demands it)'
}
console.log(`Release closure OK: dsh-ops@${pkg.version}, ${staged.join(' + ')} worker${ipcNote}.`)
