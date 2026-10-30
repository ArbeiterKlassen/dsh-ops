---
name: rea-artifact-analysis
description: Analyze shipped binaries, Electron or JavaScript applications, managed assemblies, archives, and user-owned browser or Electron targets with the pinned REA 6.8.0 gateway. Use when behavior must be grounded in shipped-artifact or runtime evidence rather than ordinary source files.
---

# REA artifact analysis

Use REA only when the answer depends on a shipped artifact, decompilation,
package internals, or a user-owned runtime. For a complete source repository,
use ordinary repository tools.

## Start with the gateway

Call `rea_status` once. If it reports `ready`, route by target with
`rea_invoke`:

- Native executable or analysis database: `open_binary`, then
  `binary_overview`. Call `close_binary` when finished.
- ASAR or extracted JavaScript/Electron tree: `analyze_javascript_application`.
- Managed PE/CLI assembly: `inspect_managed_artifact`.
- Archive, APK, IPA, MSIX, DMG, installer, or packaged app:
  `inspect_artifact`.
- User-owned browser page: `list_browser_targets`.
- User-owned Electron process: `list_electron_targets`.
- Evidence handoff: `export_evidence_bundle`.

Pass the downstream tool arguments inside `arguments`. Example:

```json
{
  "operation": "open_binary",
  "arguments": {
    "path": "D:\\samples\\target.exe"
  },
  "timeout_ms": 30000
}
```

## Keep evidence

State the artifact identity, provider, coverage, limitations, and unknowns with
every conclusion. Do not turn an inferred graph edge into observed runtime
behavior. If a result reports `status: "truncated"`, inspect its `outputPath`
with bounded `json_query` calls; never print the complete result file.

Do not repeat an unchanged call after a timeout. REA may still be running.
Report the timeout and narrow the input or explicitly raise `timeout_ms`.

## Deeper work

The adapter exposes only nine entry operations. For a deeper REA command, use
the bounded wrapper from the plugin root:

```powershell
node scripts/rea-cli.mjs <rea-command> <args>
```

The wrapper fixes the runtime, denies setup/uninstall/update/client
registration mutations, writes complete stdout and stderr under the managed
REA run directory, and returns only bounded previews. Inspect those log files
selectively.

If the runtime is missing, run:

```powershell
node scripts/rea-bootstrap.mjs
```

Static JavaScript inspection needs no Hopper, Ghidra, IDA, JADX, or Kuna.
Missing deep-analysis providers limit only operations that require them.
