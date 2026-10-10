# dsh-ops Codex plugin

This folder adapts the dsh-ops FastCtx runtime to Codex.

The adapter uses the fact that FastCtx is already an MCP stdio server. It adds three things:

- A launcher that resolves and starts `fastctx.exe`.
- A bootstrap that installs the Windows FastCtx runtime into `%CODEX_HOME%\dsh-ops\fastctx\0.2.1`.
- Codex skill instructions for file, search, replacement, and optional background work.

## Scope

File tools are the default:

- `glob`
- `grep`
- `inspect_local_file`
- `replace`

Shell and background tools are opt-in:

- `run`
- `run_background`
- `job_output`
- `job_list`
- `job_kill`

Codex already has its own shell and patch tools. The adapter keeps FastCtx shell tools off unless `DSH_OPS_ENABLE_SHELL=1` is set and a bash executable is available.

## Setup

From this folder:

```powershell
node scripts/bootstrap-fastctx.mjs
node scripts/smoke-mcp.mjs
```

The bootstrap uses npm pack to fetch `@dsh-ops/fastctx-win32-x64@0.2.1` and installs it under `%CODEX_HOME%\dsh-ops\fastctx\0.2.1`.

If npm cannot reach the registry:

```powershell
node scripts/bootstrap-fastctx.mjs --registry https://registry.npmmirror.com
node scripts/bootstrap-fastctx.mjs --from-tarball <path-to-tgz>
```

## Direct MCP configuration

Use `config.example.toml` as a starting point for a project or user `config.toml` that points at:

```text
<repository-root>\codex-plugin\scripts\start-fastctx.mjs
```

The plugin form uses `.mcp.json` and the manifests in this folder.

## Shell opt-in

Set `DSH_OPS_ENABLE_SHELL=1` before starting Codex. If bash is not on PATH, set `DSH_OPS_BASH_PATH` to Git Bash:

```powershell
$env:DSH_OPS_ENABLE_SHELL = "1"
$env:DSH_OPS_BASH_PATH = "C:\Program Files\Git\bin\bash.exe"
```

The launcher writes one diagnostic line to stderr. It never writes non-JSON data to stdout.

## Limitations

- Windows x64 only, matching the upstream FastCtx platform package.
- The DSH-specific bash and PowerShell payloads are not bundled. Git Bash is the default shell fallback for opt-in shell tools.
- Codex tool approval policy is controlled in `config.toml`, not by this plugin.
