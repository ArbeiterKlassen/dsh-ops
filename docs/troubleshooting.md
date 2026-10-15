# Troubleshooting

Start here when installation fails, an error is unclear, or behaviour is unexpected.

---

## Installation and payloads

### `bash-win32-x64` is missing under `node_modules/@dsh-ops/`

**This is not a broken installation.** The three payloads are exact-versioned **optional dependencies** (`optionalDependencies`): if your registry has not synced that platform package at the pinned version, the package manager **skips it silently** — the install still exits 0 and prints no warning that names the missing payload.

Measured on 2026-10-12: on `registry.npmmirror.com`, `@dsh-ops/bash-win32-x64` reports `dist-tags.latest = 0.0.0-stage` with `versions` holding only `0.0.0-stage`; the official `registry.npmjs.org` reports `0.2.1`. `npm view @dsh-ops/bash-win32-x64 version` through the mirror therefore prints a misleading old version — do not use it to decide whether the payload is available. This section expires by itself once the mirror catches up; below is how to verify and how to work around it.

**Preferred remedy**: `provision-shells` bypasses the registry, fetches the pinned asset from the upstream GitHub Release, checks its sha256, unpacks it and writes a `.provisioned.json` receipt.

```console
npx --yes dsh-ops@latest provision-shells --bash
```

Behind a proxy (`HTTPS_PROXY` is handed to curl explicitly as `--proxy` and is inherited through the environment as well):

```console
:: cmd
set HTTPS_PROXY=http://127.0.0.1:<clash-port>
npx --yes dsh-ops@latest provision-shells --bash
```

```console
# PowerShell
$env:HTTPS_PROXY = 'http://127.0.0.1:<clash-port>'
npx --yes dsh-ops@latest provision-shells --bash
```

**To check the result, run the profile's own copy**: `ladder` reports the bundled rung of **the copy that runs it**, so `npx … ladder` inspects the npx cache copy and its answer has nothing to do with your profile.

```console
node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-ops\bin\dsh-ops.mjs" ladder
```

The provisioned copy lives in `<DSH_HOME>/dsh-ops/shells` (shared across profiles, so one provision covers every profile on the machine) and outranks the bundled copy when the shells are resolved; `ladder` reports `source: provisioned`.

**Do not** work around a missing payload with `allowSystemShellFallback: true`: that lowers the security posture (it uses a system bash with no pinned digest), and the one-time startup configuration migration sets it back to `false`.

### `ops_bash` errors when the bundled bash payload is gone

When the bundled bash payload remains declared in the profile lockfile but its package directory has been removed by the host package manager, `ops_bash` returns a readable `ENOENT` diagnostic instead of exposing a raw `spawn` exception to the model. Restore the dependency with the profile's frozen install or official plugin manager; it does not silently switch to an unauthorized system bash.

---

## Command execution

### A whole turn is discarded as `MALFORMED_RESPONSE`

Long scripts, heredocs and multi-layer quotes and backslashes make the model escape JSON repeatedly. Write the script with the host file tools first and pass it through `script_path` instead of putting it in `command`. See the [usage guide](usage.md).

### Passing `run_in_background` to `ops_bash` is rejected

**`ops_bash` has no `run_in_background` and returns no job id**; every command runs in the foreground. The host `bash` and `pwsh` tools accept the parameter, which is why a model tries it here. For a long-running process, use the host `pwsh` tool's `run_in_background`, or detach inside the command (for example `nohup ... & disown`). Otherwise the call occupies the whole `timeoutMs` (up to about 24.9 days).

### An argument is rejected as unknown

A key the `ops_bash` schema does not declare is refused before execution, and the error names both the unknown keys and the accepted ones. This is deliberate — nothing is silently ignored.

### Empty placeholder arguments on file tools

Strict tool-call adapters that fill every schema field send `""`, `null` or `[]` for unused optional fields of `ops_inspect_local_file`, `ops_grep`, `ops_glob` and `ops_replace`. The plugin drops those placeholders for optional fields before the native worker runs, so they no longer trip `path`/`encoding`/`view` validation. Required fields, `replacement: ""`, `false` and `0` are forwarded unchanged, so genuinely invalid values still error.

---

## Permissions and sandboxing

### Do the file tools need command permission?

No. Fixed file operations follow a trusted-operation policy fence matching DSH fs-sandbox and **never execute model code**. Read-only rejects replacement, workspace-write permits writes under the workspace and DSH temporary areas, and full access adds no write fence.

### Why are the background tools still unavailable after enabling them?

Once the `dsh-ops/background` component is enabled, session `danger-full-access` is still required to publish the four background tools.

### Host shells are being refused

`shellPolicy: deny-host-shell` refuses the host shells in `deniedHostTools` (default `[pwsh, bash, pwsh_persistent]`). The policy is independent of `allowSystemShellFallback`. It also disables third-layer pwsh; enable cautiously.

---

## Installation location and profiles

### What is the `tui` profile?

`tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory.

### Why must the desktop app use its own CLI?

The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point. Desktop auto-detects `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`; for another location, specify it with `--dsh-cli`.

### `~/.fastctx/` survives uninstallation

Persistent state is kept by default; add `--purge-fastctx` explicitly if you want it removed.

### Legacy provisioned files were not cleaned up

Legacy explicitly provisioned `<DSH_HOME>/dsh-ops/` files must be cleaned separately with `npx --yes dsh-ops@latest uninstall --yes`.

---

## Processes

### Is the `runtime-host` process a leak?

No. It is a reusable upstream shared process; a dead parent alone is not a leak. With no clients and about ten minutes of inactivity, it exits normally. Do not kill it by process-name sweeps. This release does not automatically sweep processes left by older versions.

---

## See also

- [Usage](usage.md) — the complete install flow and CLI
- [Configuration reference](configuration-reference.md) — keys and owning components
- [Component reference](component-reference.md) — tools and permissions
