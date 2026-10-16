# dsh-ops

**English** | [中文](README.md)

A performance toolkit plugin for Windows DSH: it ships independent bash / PowerShell 7 and
replaces file search and batch operations with Rust, cutting the tokens, time and model
attention wasted on repeated PowerShell errors.

> tips: "ops" here is short for the general sense of operations — the plugin sits at the base layer between dsh and system / code / file operations. It is not an operations (DevOps) plugin.

**0.3.1 supports Windows x64 and Linux x64, with the Linux side verified on a real host**, targeting DSH `0.2.0-rc.2`. The independent Rust file/PTC worker ships for each supported platform (`runtime/<platform>-<arch>/`); PTC remains opt-in. macOS/ARM64 are future work, not release claims, and the shell component's pinned bash/pwsh payloads stay Windows-only: on Linux `ops_bash` runs the host distribution's own bash under a mandatory host sandbox. See [Linux support](#linux-support) and [Native PTC](docs/native-ptc.md).

---

## Features

- (All platforms) A set of Rust tools that reduce AI error loops, refusal to deliver, and lost attention, and that shrink the fixed system-prompt cost of tool definitions through progressive disclosure: faster task runs, fewer unnecessary round trips, fewer errors, and a permission model aligned with DSH.

  The author's own benchmark reported

  - 97% token reduction (ops PTC-only tools vs. the stock Windows standard mode)
  - 65% token reduction (ops PTC-only tools vs. the stock Linux PTC mode)

  and improved model performance on DSH.

- (Windows only) Independent **bash 5.3.15** and independent **PowerShell 7.6.6**: bash is preferred, and pwsh 7 is the fallback when it is needed, so your AI no longer fights PowerShell — **it does not change the system default terminal, PATH or existing host shell tool names**, and environment variables stay safe.

- Independent native Rust file tools and safe batch operations (**off by default**, opt-in), see [Component reference](docs/component-reference.md).

- A range of lightweight, easy-to-use Rust tools for DOCX and PDF processing will be added in the future; each can be toggled without taking up context.

<img width="1603" height="1028" alt="247c1326cca5b66e60d330c3f32150e2" src="https://github.com/user-attachments/assets/7c9ba485-5323-42a2-b5a8-6dcda07f91c4" />

> The illustration is the maintainer's to replace or remove.

Routing: **toolkit → bash → PowerShell 7**.

---

## Linux support

On **Linux x64** `dsh-ops` does what it does on Windows, except where noted below: the independent Rust worker ships as an ELF binary, and the file tools (`inspect_local_file` / `glob` / `grep` / `replace`) plus the opt-in PTC component (`ops_batch` / `ops_result`) work the same way there.

- **Where the shell component splits**: on Windows it is the digest-pinned bash 5.3.15 / PowerShell 7.6.6 payload plus the Bash IPC proxies; on Linux it resolves the **host distribution's own bash** (`config.bashPath` → `PATH` → `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`) and ships neither a second shell nor the pwsh overlay — a distribution bash is tied to that distribution's libc and architecture, so a second copy would add supply-chain and licensing burden without solving anything. `ops_bash` works on both; a confined mode must be enforced by a host sandbox (bwrap / Landlock), and when no sandbox can confine the call it is **refused** rather than run unrestricted. The background component, which executes through the shell component, stays Windows-only, and so does `dsh-ops provision-shells` — on Linux it refuses and points at `config.bashPath`.
- **Build and install**: see [Building and verifying on Linux](docs/linux-build.md) — `npm run verify` → `npm run build:ptc` → `npm pack` → `dsh plugin add ./dsh-ops-0.3.1.tgz`.
- **Platform differences handled**: replacing a file keeps its mode/owner/POSIX ACL/xattrs; directory `fsync` follows POSIX semantics; `multiline` search reaches across lines; reads are bounded by encoded bytes as well as by lines. The Windows-side equivalent (the security descriptor) is tracked in the [Windows verification checklist](docs/windows-verification.md).
- **Credential reads are refused by default**: the file tools (including PTC batches) refuse `~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`, `.npmrc` and the DSH credential stores before the worker is spawned, and a traversal skips those directories by identity, so `glob` cannot even list a private key's name and `grep` matches nothing inside one. Write roots are narrowed to the session's own `dsh-ops-session-<id>` temporary directory (`0700`). A row can opt out with `denyCredentialReads: false`; `DSH_OPS_DENY_READ` can only widen the fence.
- **Measured state** (Debian 13 x86_64): `DSH_OPS_REQUIRE_RUNTIME=1 npm run verify` → 30 suites passed, no skips; `npm run validate:manifest` → all 61 checks passed; `npm run verify:release` → release closure OK; a `npm pack` tarball unpacks to a worker whose receipt sha256 matches, with its execute bit intact and metadata preserved across a replace.
- The defects those runs found are **fixed here**, and Windows gains them too: a replace no longer loses mode/ACL/xattrs, `multiline` reaches across lines, one long line no longer fails a read outright, concurrent replaces no longer lose a write silently, a hard kill leaves no unbounded debris, and an unexecutable worker is named by path and mode instead of a bare `EACCES`. See the [0.3.1 release notes](docs/release-0.3.1.md) and the [CHANGELOG](CHANGELOG.md).

---

## Quick start

### Prerequisites

- **Node.js `^22.19 || >=24`** (the `engines` requirement in `package.json`)
- Windows x64 or Linux x64 (`ops_bash` works on both; the pwsh 7 overlay is Windows-only and Linux uses the distribution's own bash)
- The target DSH application initialized

### Install

**Option 1: official plugin marketplace (recommended)**

In the target DSH application's plugin marketplace, enter the npm package name **`dsh-ops`**, install, then enable. Installation belongs to the currently running profile, which is `desktop` for the desktop app.

**Option 2: one-command npm installation**

```console
npx --yes dsh-ops@latest install --profile desktop
```

An explicit target profile is required. `tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory. Initialize the target application first.

Desktop must use the CLI bundled with the desktop application; the default auto-detected path is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. For another installation location, add `--dsh-cli "<installation>\resources\runtime\cli\bin\dsh.cmd"`.

> ⚠️ **A missing `bash-win32-x64` under `node_modules/@dsh-ops/` is not a broken installation.** The three payloads are exact-versioned **optional dependencies** (`optionalDependencies`): if your registry has not synced that platform package at the pinned version, the package manager **skips it silently** — the install still exits 0 and prints no warning that names the missing payload.

> **Do not** work around a missing payload with `allowSystemShellFallback: true`: that lowers the security posture (it uses a system bash with no pinned digest), and the one-time startup configuration migration sets it back to `false`.

> **`bashPath` works only in `danger-full-access`.** Read-only and workspace-write sessions run only the pinned bundled or provisioned bash; your own Git for Windows returns `EXECUTOR_UNAVAILABLE` by design, so do not use it to work around restricted-mode problems. See the [Configuration reference](docs/configuration-reference.md).

> The ordinary DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's bundled entry point.

Details and the workaround: [Troubleshooting](docs/troubleshooting.md).

### Remove and check status

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

Replace `desktop` with `web` or `tui` as appropriate.

---

## Components

The bundle declares four independently toggled components. On first installation, the first two are enabled by default:

| Component | Description | Default | Published tools |
| --- | --- | --- | --- |
| `dsh-ops/shell` | Prefer bash as the terminal, with PowerShell 7 for operations bash cannot cover | On | `ops_bash`; host `pwsh` uses bundled PowerShell 7 |
| `dsh-ops/file` | Faster, higher-performance Rust file retrieval with more concise, token-efficient output | On | Four file tools |
| `dsh-ops/background` | Managed background tasks for scientific simulations, model training and other long-running processes | Off | Start, read output, list and terminate background jobs |
| `dsh-ops/ptc` | Independent Rust safe batches and bounded result references, only in pure PTC sessions | Off | `ops_batch`, `ops_result` |

"Prefer bash as the terminal" means prompting the model to use `ops_bash` first; it **does not change the system default terminal, PATH or existing host shell tool names**.

Full tool parameters, configuration keys and permission requirements: [Component reference](docs/component-reference.md) and [Configuration reference](docs/configuration-reference.md).

> Migration completion marker: after completion, restarts/hot reload do not overwrite a later manual `true`. Do not remove the marker unless you intend to repeat the self-check.

---

## Documentation

| To learn about | Read |
| --- | --- |
| The complete install, update and remove flow with every option | [docs/usage.md](docs/usage.md) |
| Every configuration key, and which component owns it | [docs/configuration-reference.md](docs/configuration-reference.md) |
| What tools each of the four components publishes, with parameters and permissions | [docs/component-reference.md](docs/component-reference.md) |
| How to read the errors, what to do when installation fails | [docs/troubleshooting.md](docs/troubleshooting.md) |
| The native PTC design and usage | [docs/native-ptc.md](docs/native-ptc.md) |
| How to build, configure and troubleshoot Linux x64 | [docs/linux-build.md](docs/linux-build.md) |
| Version history | [CHANGELOG.md](CHANGELOG.md) |
| Provenance and payload license records | [PROVENANCE.md](PROVENANCE.md) |

---

## License

Plugin source distribution uses **`MIT AND Apache-2.0`**: files outside `vendor/fastctx/` are MIT; vendored FastCtx is Apache-2.0. See [NOTICE](NOTICE), `vendor/fastctx/LICENSE-APACHE` and `vendor/fastctx/NOTICE`.

Independent Windows payload packages are distributed under their upstream component licenses: Git for Windows includes GPL and other licensed components; PowerShell includes MIT and third-party components. Original licenses, notices and provenance records are retained with the payloads; the plugin's MIT license does not replace them. See [PROVENANCE.md](PROVENANCE.md).

## Acknowledgements

The Rust tools are based on [yc-duan](https://github.com/yc-duan)'s FastCtx Codex plugin and use its source code. Vendor identification and deletion-only distribution changes are recorded in [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) and [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md). The required FastCtx notice follows:

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=T-Auto/dsh-ops&type=Date)](https://star-history.com/#T-Auto/dsh-ops&Date)
