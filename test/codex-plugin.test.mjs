/**
 * The Codex adapter is a separate MCP surface over the packaged native worker.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  PACKAGE_ROOT,
  assert,
  report,
  test,
} from './lib/harness.mjs'

const script = path.join(
  PACKAGE_ROOT,
  'codex-plugin',
  'scripts',
  'smoke-mcp.mjs',
)

test('the Codex adapter performs a native-worker MCP round trip', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      DSH_OPS_WORKSPACE_ROOT: PACKAGE_ROOT,
    },
  })

  assert.equal(
    result.status,
    0,
    `smoke-mcp failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /"name": "dsh-ops"/)
  assert.match(result.stdout, /"version": "0.4.1"/)
  assert.match(result.stdout, /"read_docx"/)
  assert.match(result.stdout, /glob: \d+ MCP files/)
  assert.match(result.stdout, /stat: [0-9a-f]{12}/)
})

report('codex-plugin')
