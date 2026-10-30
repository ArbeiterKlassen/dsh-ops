---
name: dsh-maintenance
description: Diagnose Codex plugins, MCP registrations, thread storage, context cost, and cache behavior with bounded reads, snapshots, and reversible cleanup. Use for Codex maintenance work; this workflow never bypasses approvals or patches the host to remove safety controls.
---

# Codex maintenance

Start with the smallest evidence that can locate the fault.

## Diagnose before changing

Use `rea_status` to inspect the pinned REA runtime. Use `grep`, `glob`,
`json_query`, and bounded reads for plugin manifests, launch logs, and thread
metrics. Never dump `$CODEX_HOME/config.toml`, a rollout JSONL, or a large
plugin cache file into model context.

For thread structure, provider-cache, tool-output, or compaction problems,
load `codex-thread-json-debugger` and use its audit scripts. For stale image
payloads, load `codex-thread-image-cleaner`; use its length-preserving rollout
repair before deleting any cache.

## Protect state

Snapshots belong in a project-local `archive/` directory. Resolve and list
absolute targets before a recursive move or cleanup. Keep full diagnostic
output in a log file and return counts, dominant records, and a short preview.

Codex approval policy remains authoritative. Do not install rules that
auto-approve commands, inject identities, strip host restrictions, rewrite the
Codex application, or silently widen filesystem or network scope.

## Audit scope

For path or network scope questions, run the read-only audit:

```powershell
node scripts/scope-audit.mjs `
  --allow-root "D:\workspace" `
  --path "D:\workspace\artifact.bin" `
  --allow-host "api.example.com" `
  --url "https://api.example.com/v1/status"
```

The script canonicalizes paths, rejects credential locations, checks allowed
roots, rejects URL userinfo and non-HTTP schemes, and checks exact or
subdomain host scope. It does not alter approvals or configuration.

## Verify installation

After changing the plugin, run the adapter smoke test, manifest checks, skill
validators, and the installed-cache smoke from the newly installed version.
State clearly whether the current Codex session has loaded that version or
needs a restart.
