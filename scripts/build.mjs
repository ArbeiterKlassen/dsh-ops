#!/usr/bin/env node
/** Compile source to the published lib paths, then copy component and panel assets. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src')
const output = path.join(root, 'lib')
const compiler = path.join(root, 'node_modules/typescript/lib/tsc.js')
const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/i

function copyAssets(directory) {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name)
    if (entry.isDirectory()) count += copyAssets(from)
    else if (entry.isFile() && !codeFile.test(entry.name)) {
      const to = path.join(output, path.relative(source, from))
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
      count++
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported source entry: ${path.relative(root, from)}`)
    }
  }
  return count
}

try {
  if (!existsSync(compiler)) throw new Error('TypeScript is missing; run npm ci --ignore-scripts first.')
  // Both paths are fixed children of this checkout. Remove only generated output so deleted
  // source modules cannot remain importable after a successful rebuild.
  rmSync(output, { recursive: true, force: true })
  const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    console.error('build: TypeScript compilation failed; assets were not copied.')
  } else {
    const assets = copyAssets(source)
    console.log(`build: compiled src/ to lib/ and copied ${assets} assets`)
  }
} catch (error) {
  console.error(`build: ${error.message}`)
  process.exitCode = 1
}
