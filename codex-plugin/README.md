# dsh-ops Codex plugin

This folder adapts the `dsh-ops@0.4.4` native Rust worker and pins REA 6.8.0
for Codex.

The 0.4.4 worker is a one-shot JSON process, not an MCP server. The adapter
supplies a small MCP bridge, the upstream tool schemas, and the packaged Windows
x64 worker. It does not use FastCtx and does not require bash.

## Tool surface

The MCP server exposes:

- Read and search: `inspect_local_file`, `json_query`, `read_files`, `glob`,
  `grep`, `stat`, `diff`
- Revision-checked mutations: `replace`, `write_file`, `edit_file`, `copy`,
  `move`, `remove`
- Documents: `read_table`, `read_docx`, `read_pdf`
- References: `result`

The second MCP server exposes only two stable tools:

- `rea_status` reports the pinned Node and REA runtime.
- `rea_invoke` forwards an allowlisted entry operation to REA. The operation
  enum covers native binaries, JavaScript/Electron applications, managed
  assemblies, packaged artifacts, browser/Electron target discovery, and
  evidence export.

REA advertises 229 upstream tools whose schemas are several megabytes. This
adapter deliberately does not register them. The compact gateway keeps the
tool catalog stable while deeper commands remain available through the bounded
`scripts/rea-cli.mjs` wrapper. Complete CLI output is written under the managed
REA run directory; the model receives counts and bounded previews.

The document readers are bounded. `read_table` handles CSV/TSV only,
`read_docx` reads main-body paragraphs, and `read_pdf` supports classic xref,
xref streams, object streams, incremental revisions, and a restricted
standard-font text layer. These are not general Office or OCR converters.

`json_query` is the bounded entry point for large/minified JSON. It selects a
property/index path, optionally filters array objects by field, projects named
fields, and returns only a limited context window. The file is parsed in the
adapter memory; the complete JSON is never returned to model context.
`read_files` and `inspect_local_file` reject JSON files over 64 KiB or detected
as minified, returning `JSON_QUERY_REQUIRED`.

Every MCP tool response is capped at 20,000 characters after worker parsing. A
larger response is returned as a bounded preview with
`truncatedBy: "adapter-output-budget"` and an instruction to page or narrow the
request. This cap applies to text, table, document, search, and JSON results, so
one call cannot flood the model context. The worker's 128 KiB process-output
ceiling remains a separate safety limit.

## Workflow skills

Nine companion skills turn common PowerShell and analysis patterns into bounded
recipes:

- `dsh-repo-scan` uses `stat` and `glob` for file inventory and metadata.
- `dsh-text-search` escalates from `grep` summary to count/files and then a
  20-hit content window.
- `dsh-bounded-read` standardizes text slices, JSON projections, tables, DOCX,
  and PDF excerpts.
- `dsh-task-run` keeps Node, Python, build, test, and verification output to an
  exit code, a compact failure summary, and an optional log path.
- `dsh-safe-edit` previews revision-checked edits and literal replacement before
  writing.
- `dsh-document-extract` pages CSV/TSV, DOCX paragraphs, and PDF text pages.
- `rea-artifact-analysis` routes shipped artifacts through the fixed REA
  gateway and preserves Evidence coverage limits.
- `dsh-maintenance` audits Codex plugins, threads, context cost, and caches
  without bypassing approvals.
- `dsh-scope-audit` checks local paths and HTTP hosts against explicit
  allowlists without changing approval state.

The workflows only guide existing tools. They do not change the MCP tool
catalog while a task is running.

## Verify

From this folder:

```powershell
node scripts/bootstrap-native.mjs
node scripts/smoke-mcp.mjs
node scripts/rea-bootstrap.mjs
node scripts/smoke-rea.mjs
```

The first command verifies the bundled worker's SHA-256 provenance receipt and
version. The second starts the real MCP server, lists all 17 tools, and calls
`glob` plus `stat`. `node scripts/smoke-json-query.mjs` verifies the bounded
JSON selector/filter/context path, the summary-first `grep` recipe, rejection of
large line-oriented JSON reads, and the 20,000-character response ceiling.
`rea-bootstrap.mjs` installs the exact Node 24.22.1 and REA 6.8.0 pair under
`%CODEX_HOME%\dsh-ops\rea\6.8.0`; `smoke-rea.mjs` starts the gateway and checks
the real REA server identity.

## Direct MCP configuration

Use `config.example.toml` as a starting point for a project or user
`config.toml`. The server command is:

```text
node <repository-root>\codex-plugin\scripts\native-mcp.mjs
node <repository-root>\codex-plugin\scripts\rea-mcp.mjs
```

The plugin form uses `.mcp.json` and the manifests in this folder.

## Runtime selection

The worker resolves in this order:

1. `DSH_OPS_WORKER_BIN`
2. `%CODEX_HOME%\dsh-ops\native\0.4.4\dsh-ops-worker.exe`
3. `codex-plugin\worker\win32-x64\dsh-ops-worker.exe`
4. `dsh-ops-worker.exe` on `PATH`

The bundled copy makes a normal Codex plugin installation self-contained.

REA resolves in this order:

1. `REA_NODE_BIN` and `REA_PACKAGE_ENTRY`
2. `%CODEX_HOME%\dsh-ops\rea\6.8.0\node_modules\node\bin\node.exe`
3. `%CODEX_HOME%\dsh-ops\rea\6.8.0\node_modules\rea-agents\scripts\rea.mjs`

The managed pair is installed separately because the node and REA dependency
trees are much larger than the lightweight dsh-ops worker.

## Safety controls

- Pass absolute paths. `DSH_OPS_WORKSPACE_ROOT` sets the base for relative
  paths in direct MCP mode.
- Set `DSH_OPS_WRITE_ROOT` to one absolute directory to confine workspace
  writes to that tree.
- Set `DSH_OPS_READ_ONLY=1` to reject every mutation.
- Credential directories and private-key paths are denied by the adapter and
  worker.
- Large/minified JSON paths are denied to line-oriented readers and must use
  `json_query`.
- Codex credential locations, including `auth.json`, `secrets`, and
  `.sandbox-secrets`, are denied below the user home and an explicit
  `CODEX_HOME`.
- Every model-visible MCP response is capped at 20,000 characters.
- REA operations are limited to a fixed nine-operation enum; all other upstream
  tools stay out of the model catalog.
- Oversized REA results are persisted under the managed REA results directory
  and returned as a bounded summary.
- Scope auditing is read-only and never changes Codex approvals.
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
