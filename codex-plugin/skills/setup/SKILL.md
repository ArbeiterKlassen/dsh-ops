---
name: dsh-ops-setup
description: Install, verify, and diagnose the Codex dsh-ops plugin runtime. Triggers when the dsh-ops MCP server is missing, fastctx.exe cannot be found, or the user asks to set up dsh-ops in Codex.
---

# Set up dsh-ops for Codex

Use this workflow when the dsh-ops MCP server is not available.

1. Locate the plugin root. It is the directory containing `plugin.json` and `.codex-plugin/plugin.json`.
2. Run the runtime bootstrap:

```powershell
node scripts/bootstrap-fastctx.mjs
```

3. Verify the MCP handshake and tool list:

```powershell
node scripts/smoke-mcp.mjs
```

4. If the user wants `run` and background job tools, set `DSH_OPS_ENABLE_SHELL=1` and optionally set `DSH_OPS_BASH_PATH` to a trusted bash executable.
5. Restart Codex after changing MCP server or plugin configuration.

## Diagnostics

- If bootstrap cannot reach the npm registry, pass `--registry` with a reachable registry, or use `--from-tarball` with a local `@dsh-ops/fastctx-win32-x64` tarball.
- If `fastctx.exe` exists but the handshake fails, run `node scripts/smoke-mcp.mjs` and read stderr first.
- If shell tools are requested but no bash is found, set `DSH_OPS_BASH_PATH` to Git Bash or another trusted bash executable.
- The plugin deliberately keeps shell tools off by default. File tools do not need bash.
