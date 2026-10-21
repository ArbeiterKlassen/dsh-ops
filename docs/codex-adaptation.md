# Codex adapter design

## Goal

Expose the `dsh-ops@0.4.1` native file worker to Codex without reproducing the
DSH host runtime or reintroducing the removed FastCtx transport.

## Runtime change in 0.4.1

Upstream 0.4.1 uses one bounded Rust executable. Each call receives one v1 JSON
envelope on stdin and writes one JSON result on stdout. The worker performs
authority checks, path validation, search, reads, revisions, atomic edits, and
bounded document parsing. It does not expose an MCP server directly.

The Codex adapter therefore adds a stdio MCP process around the worker.

## Adapter layout

```text
codex-plugin/
├─ scripts/
│  ├─ native-mcp.mjs
│  ├─ bootstrap-native.mjs
│  ├─ smoke-mcp.mjs
│  └─ runtime.mjs
├─ vendor/
│  ├─ credential-policy.js
│  └─ capabilities/
│     ├─ documents.js
│     ├─ file.js
│     └─ result.js
└─ worker/
   └─ win32-x64/
      ├─ dsh-ops-worker.exe
      └─ provenance.json
```

The tool schemas are copied from the 0.4.1 published build. Keeping the
generated schema helpers in the plugin makes the installed cache independent of
the repository's built `lib/` directory.

## MCP bridge

`native-mcp.mjs` implements the JSON-RPC methods Codex needs for a tools-only
server:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`
- `ping`
- `shutdown`

Each `tools/call` builds a fresh version-1 worker envelope and starts one worker
process. The adapter limits stdin to 2 MiB, stdout to 128 KiB, stderr to 16 KiB,
and execution to 30 seconds.

Stdout carries MCP JSON only. Diagnostics go to stderr.

## Tool surface

The adapter exposes 16 native tools:

```text
inspect_local_file grep glob replace write_file edit_file diff stat
copy move remove read_files read_table read_docx read_pdf result
```

Mutation tools retain the worker's revision checks. `replace` can be previewed
with `dryRun`. `write_file` uses `expectedRevision: "absent"` for create-only
operation.

The PTC execution lane is not bridged. PTC is a DSH agent-loop feature with
progressive tool loading and confined code execution. Reproducing that inside
MCP would add a second security and lifecycle model. The native worker's common
file/document tools are sufficient for Codex.

## Runtime selection

The worker resolves in this order:

1. `DSH_OPS_WORKER_BIN`
2. Managed `%CODEX_HOME%\dsh-ops\native\0.4.1\<worker>`
3. The worker packaged inside the plugin
4. `PATH`

The packaged copy is included so Codex can copy only the plugin directory into
its cache.

## Authority and approvals

Codex owns MCP tool approval. The adapter adds three worker controls:

- `DSH_OPS_READ_ONLY=1` rejects mutations.
- `DSH_OPS_WRITE_ROOT=<absolute-path>` supplies a workspace-write boundary.
- `DSH_OPS_WORKSPACE_ROOT=<absolute-path>` sets the root for relative paths.

Credential roots are passed to the worker as traversal exclusions, and
credential names remain denied. A direct path into a denied location is
refused.

## Verification

Three checks are required:

1. `bootstrap-native.mjs` verifies the provenance version and SHA-256.
2. `smoke-mcp.mjs` performs a real MCP initialize, tool list, `glob`, and
   `stat`.
3. The installed plugin cache reruns the same smoke from its own directory.

The second run proves the cache is self-contained and that the MCP server does
not depend on repository files.

## Known limits

- No FastCtx background jobs. Upstream 0.4.1 removed that component.
- No PTC `run_code` or `load_sdk`.
- No trusted result cache, so references are consumed only when supplied by a
  compatible worker deployment.
- The bundled binary is Windows x64. Other targets need a matching worker and
  provenance receipt.
