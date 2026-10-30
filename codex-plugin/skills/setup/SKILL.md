---
name: dsh-ops-setup
description: Verify and diagnose the packaged dsh-ops 0.4.4 native worker used by the Codex MCP plugin.
---

# Verify dsh-ops for Codex

The 0.4.5 adapter is self-contained. It no longer downloads or starts FastCtx.

1. Locate the plugin root containing `plugin.json` and
   `.codex-plugin/plugin.json`.
2. Check the bundled worker and provenance:

```powershell
node scripts/bootstrap-native.mjs
```

3. Run the MCP handshake, tool inventory, `glob`, and `stat`:

```powershell
node scripts/smoke-mcp.mjs
```

4. Restart Codex after installing or replacing the plugin.

## Diagnostics

- The bundled Windows x64 binary is
  `worker/win32-x64/dsh-ops-worker.exe`.
- `DSH_OPS_WORKER_BIN` selects a different compatible worker.
- `DSH_OPS_WORKSPACE_ROOT` sets the root used to resolve relative paths.
- `DSH_OPS_WRITE_ROOT` restricts workspace-write calls to one absolute tree.
- `DSH_OPS_READ_ONLY=1` rejects mutation tools.
- Worker protocol failures appear on stderr and never write non-JSON data to
  stdout.

The worker version must print `dsh-ops-worker 0.4.4`. A provenance mismatch or
an MCP handshake failure is an installation error, not a reason to fall back
to the removed FastCtx runtime.
