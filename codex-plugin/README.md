# dsh-ops Codex plugin

This folder adapts the `dsh-ops@0.4.1` native Rust worker to Codex.

The 0.4.1 worker is a one-shot JSON process, not an MCP server. The adapter
supplies a small MCP bridge, the upstream tool schemas, and the packaged Windows
x64 worker. It does not use FastCtx and does not require bash.

## Tool surface

The MCP server exposes:

- Read and search: `inspect_local_file`, `read_files`, `glob`, `grep`, `stat`,
  `diff`
- Revision-checked mutations: `replace`, `write_file`, `edit_file`, `copy`,
  `move`, `remove`
- Documents: `read_table`, `read_docx`, `read_pdf`
- References: `result`

The document readers are bounded. `read_table` handles CSV/TSV only,
`read_docx` reads main-body paragraphs, and `read_pdf` supports classic xref,
xref streams, object streams, incremental revisions, and a restricted
standard-font text layer. These are not general Office or OCR converters.

## Verify

From this folder:

```powershell
node scripts/bootstrap-native.mjs
node scripts/smoke-mcp.mjs
```

The first command verifies the bundled worker's SHA-256 provenance receipt and
version. The second starts the real MCP server, lists all 16 tools, and calls
`glob` plus `stat`.

## Direct MCP configuration

Use `config.example.toml` as a starting point for a project or user
`config.toml`. The server command is:

```text
node <repository-root>\codex-plugin\scripts\native-mcp.mjs
```

The plugin form uses `.mcp.json` and the manifests in this folder.

## Runtime selection

The worker resolves in this order:

1. `DSH_OPS_WORKER_BIN`
2. `%CODEX_HOME%\dsh-ops\native\0.4.1\dsh-ops-worker.exe`
3. `codex-plugin\worker\win32-x64\dsh-ops-worker.exe`
4. `dsh-ops-worker.exe` on `PATH`

The bundled copy makes a normal Codex plugin installation self-contained.

## Safety controls

- Pass absolute paths. `DSH_OPS_WORKSPACE_ROOT` sets the base for relative
  paths in direct MCP mode.
- Set `DSH_OPS_WRITE_ROOT` to one absolute directory to confine workspace
  writes to that tree.
- Set `DSH_OPS_READ_ONLY=1` to reject every mutation.
- Credential directories and private-key paths are denied by the adapter and
  worker.
- Codex approval policy remains authoritative. Use the mutation approval
  entries in `config.example.toml`.

## Limits

- This build carries a Windows x64 worker. Other platforms can use a matching
  worker through `DSH_OPS_WORKER_BIN`.
- PTC `run_code`, DSH host shell integration, the DSH panel, and the DSH TUI are
  not exposed through this MCP adapter.
- References use session-bound worker storage in DSH. This adapter does not
  provide trusted storage, so calls return bounded inline output rather than
  creating new result references.
