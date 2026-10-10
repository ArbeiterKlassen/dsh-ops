# Codex adapter design

## Goal

Make the FastCtx runtime available to Codex without weakening the DSH plugin's own boundaries.

FastCtx already speaks MCP over stdio. The Codex adapter therefore does not reimplement file tools or proxy JSON-RPC. It supplies three pieces:

1. A launcher that resolves `fastctx.exe`, prepares the environment, and hands stdio to Codex.
2. A bootstrap that installs the Windows FastCtx package under `%CODEX_HOME%\dsh-ops\fastctx\0.2.1`.
3. A Codex plugin manifest and skill that describe when to use the tools.

## Runtime layout

The adapter keeps the runtime outside the plugin cache:

```text
%CODEX_HOME%\dsh-ops\fastctx\0.2.1\
├─ fastctx.exe
├─ package\
└─ licenses\
```

This matters because Codex can copy a marketplace plugin into a cache directory. A runtime stored inside the plugin folder would be duplicated and could become stale. The bootstrap puts the executable in a stable location that survives plugin cache refreshes.

## Launcher

`codex-plugin/scripts/start-fastctx.mjs` resolves FastCtx in this order:

1. `DSH_OPS_FASTCTX_BIN`
2. The managed runtime under `%CODEX_HOME%`
3. The unpacked platform package under the managed runtime
4. The plugin's `node_modules`
5. The repository's `node_modules`
6. `PATH`

It removes credential-shaped environment variables and `DSH_*` variables before starting FastCtx. The child receives `FASTCTX_NO_PARENT_WATCH=0`.

## Tool surface

File tools are enabled by default:

- `glob`
- `grep`
- `inspect_local_file`
- `replace`

Shell tools require `DSH_OPS_ENABLE_SHELL=1` and a bash executable:

- `run`
- `run_background`
- `job_output`
- `job_list`
- `job_kill`

The launcher resolves bash from `DSH_OPS_BASH_PATH`, the managed bash runtime, Git for Windows, or `PATH`. If no bash is available, it starts FastCtx without shell tools instead of failing the whole plugin.

## Codex plugin shape

The adapter follows the portable Agent Plugins layout:

```text
codex-plugin/
├─ plugin.json
├─ mcp.json
├─ .codex-plugin\plugin.json
├─ .mcp.json
├─ skills\
│  ├─ dsh-ops\SKILL.md
│  └─ setup\SKILL.md
└─ scripts\
   ├─ runtime.mjs
   ├─ bootstrap-fastctx.mjs
   ├─ start-fastctx.mjs
   └─ smoke-mcp.mjs
```

The repository marketplace at `.agents\plugins\marketplace.json` points at `./codex-plugin`.

## Verification

The adapter was tested in three modes:

1. Direct MCP handshake with `DSH_OPS_FASTCTX_BIN` pointing at an unpacked FastCtx release.
2. Managed-runtime resolution after provisioning `%CODEX_HOME%\dsh-ops\fastctx\0.2.1`.
3. Shell opt-in with Git Bash, including `run` and `run_background` plus `job_output`.

The expected file tool list is `glob`, `grep`, `inspect_local_file`, `replace`. The expected shell-enabled list adds `run`, `run_background`, `job_output`, `job_list`, and `job_kill`.

## Limits

- Windows x64 only, matching the published FastCtx platform package.
- The DSH plugin's bundled bash and PowerShell payloads are not part of this adapter. Git Bash is the default shell fallback for opt-in shell tools.
- Codex tool approval policy stays in Codex configuration. The adapter does not bypass it.
- The adapter does not modify the user's global Codex configuration. Use the plugin marketplace or the example `config.toml` entry.
