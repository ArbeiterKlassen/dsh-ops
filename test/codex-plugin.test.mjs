/**
 * The Codex adapter's runtime gate.
 *
 * The adapter is a separate MCP surface, so it gets its own handshake check.
 * The suite skips when no FastCtx binary is resolvable, matching the upstream
 * lifecycle and mount suites. Set DSH_OPS_FASTCTX_BIN to force the check.
 */

import path from 'node:path'
import {
  PACKAGE_ROOT,
  assert,
  report,
  skipSuite,
  test,
} from './lib/harness.mjs'
import { resolveBinary } from '../lib/binary.js'
import { McpStdioClient } from '../lib/handshake.js'

let runtime
try {
  runtime = resolveBinary({ packageRoot: PACKAGE_ROOT })
} catch {
  skipSuite('codex-plugin', 'no FastCtx executable found')
}

const launcher = path.join(PACKAGE_ROOT, 'codex-plugin', 'scripts', 'start-fastctx.mjs')
const pluginRoot = path.join(PACKAGE_ROOT, 'codex-plugin')

test('the Codex launcher exposes exactly the default file tools', async () => {
  const client = McpStdioClient.start({
    file: process.execPath,
    args: [launcher],
    cwd: pluginRoot,
    env: { ...process.env, DSH_OPS_FASTCTX_BIN: runtime.file },
    timeoutMs: 60_000,
  })
  try {
    const init = await client.initialize('codex-plugin-test')
    assert.equal(init.serverInfo?.name, 'fastctx')
    const tools = await client.listTools()
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      ['glob', 'grep', 'inspect_local_file', 'replace'],
    )
  } finally {
    await client.close()
  }
})

report('codex-plugin')
