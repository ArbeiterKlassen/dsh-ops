/** npm source closure: compiled host code and path crates survive packing, without build caches. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

await test('npm pack includes compiled host code and native sources, never host sources or build caches', () => {
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path)
  const required = ['lib/index.js', 'lib/policy.js', 'lib/components/panel/index.js',
    'lib/components/panel/package.json', 'lib/components/panel/icon.png', 'lib/panel/panel.html',
    'lib/components/tui/dsh-plugin.json', 'native/Cargo.toml', 'native/Cargo.lock', 'native/src/lib.rs',
    'native/windows-metadata/Cargo.toml', 'native/windows-metadata/src/lib.rs',
    'native/darwin-metadata/Cargo.toml', 'native/darwin-metadata/src/lib.rs']
  for (const name of required) assert.ok(files.includes(name), `missing source-build dependency: ${name}`)
  assert.equal(files.some(name => name.startsWith('src/')), false, 'host source must not ship beside compiled lib/')
  assert.equal(files.some(name => /^native\/(?:target[^/]*|(?:windows|darwin)-metadata\/target)\//u.test(name)), false)
  const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, 'native/Cargo.toml'), 'utf8')
  for (const match of manifest.matchAll(/^path\s*=\s*"([^"]+)"/gmu)) {
    // src/lib.rs is a file; the adapter dependency is a directory with a manifest.
    const relative = `native/${match[1]}`
    assert.ok(files.includes(relative) || files.includes(`${relative}/Cargo.toml`), `unpacked Cargo path is missing: ${relative}`)
  }
})
report('package-source')
