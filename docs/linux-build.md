# Building and running dsh-ops on Linux x64

Linux x64 is a supported target for the **file**, **ptc** and **background**
components. The **shell** component (`ops_bash`, bundled PowerShell 7, the bash
IPC proxies) remains Windows x64 only — on Linux there is no bundled bash to
publish, so the plugin never pretends otherwise.

Nothing on Linux is downloaded with the package: the native workers are staged
locally from source, which is why this page exists. The npm package still
carries the Windows x64 payloads (`@dsh-ops/*-win32-x64`); Linux has no payload
packages to fetch.

| Component | Linux x64 | Notes |
| --- | --- | --- |
| `dsh-ops/file` | yes | 4 tools: `ops_inspect_local_file`, `ops_grep`, `ops_glob`, `ops_replace` |
| `dsh-ops/ptc` | yes | `ops_batch`, `ops_result`; opt-in |
| `dsh-ops/background` | yes, with a bash | job tools are gated on a resolvable bash — see below |
| `dsh-ops/shell` | no | `ops_bash` and pwsh stay Windows x64 |

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `^22.19 \|\| >=24` | `package.json` `engines` |
| Rust | `1.88` or newer (`cargo`) | `native/Cargo.toml` and `vendor/fastctx/Cargo.toml` `rust-version` |
| pnpm | any recent | `dsh plugin` forwards to it |
| DSH | `0.2.0-rc.2` | the host this release targets |

## 1. Get the source

```console
$ git clone https://github.com/T-Auto/dsh-ops.git
$ cd dsh-ops
```

## 2. Install dependencies

```console
$ npm install
added 45 packages in 499ms
```

The root package declares `"os": ["win32", "linux"]`, so npm applies no platform
veto here. On a tree whose `os` list is still Windows-only — the published 0.3.0
tarball, for instance — the same command stops at `EBADPLATFORM`, and the
published `npx dsh-ops@latest install` entry point is unusable on Linux for that
reason. See [Installing into a profile](#6-install-into-a-profile) for the path
that works regardless of how the tarball was published.

If you do need to force a Windows-only tree to install on Linux, `npm install
--force` does it; note that this also skips npm's script gate. Three
dependencies ship install scripts (`node-pty`, `koffi`,
`@deepseek-ai/dsh-subprocess-local`); the suites that need them will say so
rather than pass silently.

## 3. Build the native worker

```console
$ npm run build:ptc
toolchain: cargo 1.98.1
    Finished `release` profile [optimized] target(s) in 3.05s
linux-x64: 3665672 bytes, sha256 327420ad9660…f9c8b0efc9445c0c
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

This compiles `native/` and stages the result into the install-relative layout
the runtime resolver reads:

```text
runtime/linux-x64/dsh-ops-worker
runtime/linux-x64/provenance.json
```

`provenance.json` carries the target, the package version, the executable name
and the SHA-256 of the binary. `resolveWorker()` re-derives that digest on every
resolution and refuses a staged worker whose receipt does not match, so a
half-copied or hand-edited `runtime/` fails closed instead of running.

Verify it is wired up:

```console
$ node bin/dsh-ops.mjs status
```

## 4. Build FastCtx (only for the background component)

The file and PTC components use their own Rust worker and do **not** need
FastCtx. Only `dsh-ops/background` does, so this step is optional.

```console
$ cargo build --release --locked --manifest-path vendor/fastctx/Cargo.toml
    Finished `release` profile [optimized] target(s) in 2m 33s
```

The binary lands at `vendor/fastctx/target/release/fastctx`. Point the plugin at
it either way:

```console
$ export DSH_OPS_FASTCTX_BIN="$PWD/vendor/fastctx/target/release/fastctx"
```

or per profile row:

```yaml
- id: dsh-ops-background
  disabled: false
  config:
    binaryPath: /absolute/path/to/fastctx
    enableShellTools: true
```

`resolveBinary()` searches the managed runtime, the vendored build, this
package's own platform package, the published `@fastctx/<platform>-<arch>`
package, and `PATH`, in that order — and reports every rung it tried when it
finds nothing, so a missing runtime is never a silent mystery.

## 5. Verify on this machine

The gate has three outcomes — passed, failed, skipped — and a skip is never
counted as a pass. `DSH_OPS_REQUIRE_RUNTIME=1` turns a skip into a failure, so
this is the strictest form:

```console
$ DSH_OPS_FASTCTX_BIN="$PWD/vendor/fastctx/target/release/fastctx" \
  DSH_OPS_REQUIRE_RUNTIME=1 npm run verify
…
dsh-ops test: 13 suite(s) passed in 10s
```

Without a FastCtx build the same command reports fewer suites and lists the
skipped ones explicitly:

```console
dsh-ops lifecycle: skipped (no FastCtx executable found; …)
dsh-ops mount: skipped (no FastCtx executable found; …)
dsh-ops test: 11 suite(s) passed, 2 skipped in 2s
```

The Rust worker's own barrier test:

```console
$ cargo test --release --locked --manifest-path native/Cargo.toml
test result: ok. 1 passed; 0 failed
```

## 6. Install into a profile

`npx dsh-ops@latest install` is the documented Windows path and requires a
Windows-only npm tarball. On Linux, install from the checkout through DSH's own
plugin manager, which forwards to pnpm:

```console
$ dsh plugin --profile <profile> add /absolute/path/to/dsh-ops
```

To install a build you already made elsewhere, pack it first (the `files` list
ships `runtime/`, so the staged worker travels with the tarball):

```console
$ npm pack
$ dsh plugin --profile <profile> add ./dsh-ops-0.3.0.tgz
```

Confirm what the host composed:

```console
$ dsh --profile <profile> --dump-config
```

## Configuring the shell lane

On Linux the plugin publishes no bash and no PowerShell, so the `shell`
component has nothing to offer and the `background` component's job tools
(`ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) stay
unpublished. That is fail-closed, not a bug: `FastCtxTools.shellAllowed()`
refuses a command surface when no executor is resolvable.

To get those tools, name the bash explicitly:

```yaml
- id: dsh-ops-background
  config:
    bashPath: /usr/bin/bash
```

> **`allowSystemShellFallback: true` will not do it.** The startup config
> migration rewrites that key back to `false` on purpose — it is a security
> posture downgrade (an unpinned system shell) and the migration will not let a
> deployment drift into it silently. `bashPath` is the sanctioned, explicit
> alternative, and a configured path is authoritative: it wins over PATH and the
> bundled layouts.
>
> This holds in restricted modes too: `workspace-write` and `read-only`
> confinement rejects an MSYS-style bash whose digest is not pinned, so point
> `bashPath` at a plain system bash and let the DSH sandbox confine it.

## Troubleshooting

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `Unsupported runtime target linux-x64` | a build whose `PLATFORMS` list predates Linux support | use a version that lists `linux-x64`, or build from a checkout that does |
| `Error: Unsupported target` from `build:ptc`, after a successful compile | the stage step rejected the target | same as above; the compile itself is fine |
| `npm error code EBADPLATFORM` | the published tarball declares `os: ["win32"]` | install from a checkout/`npm pack` through `dsh plugin` |
| file tools silently missing, no error | `resolveWorker()` threw and the component degraded: `required` defaults to `false` | set `required: true` on the `dsh-ops/file` row to make it loud |
| `Bad file descriptor (os error 9)` in `preflight` | the audit store or atomic replace synced a directory handle that cap-std opened `O_PATH` on Linux, where `fsync` is refused | fixed in `native/src/lib.rs`; rebuild with `npm run build:ptc` |
| a denied command reports a generic failure instead of `POLICY_DENIED` | the host's English denial signatures were matched against a localized libc message | the bash lane pins `LC_MESSAGES=C`; a non-English host on an older build shows this |
| job tools never appear | no resolvable bash | set `bashPath`, see above |

## Why a local build

The npm package ships Windows x64 payloads only. A Linux deployment therefore
has no downloaded worker to fall back on, and the plugin's runtime resolution is
installation-relative by design: it will not silently pick up a binary from an
unrelated location. Building from the checkout is the supported path, and every
artefact it produces is digest-checked before it runs.
