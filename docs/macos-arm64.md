# macOS arm64 support

This branch extends `dsh-ops` from Windows x64 only to Windows x64 **and** macOS
arm64 (`darwin-arm64`), targeting DSH `0.2.0-rc.2`.

## Scope

| Item | Windows x64 | macOS arm64 |
| --- | --- | --- |
| Status | Shipped by 0.3.0 | Added by this branch |
| Native worker | `runtime/win32-x64/dsh-ops-worker.exe` | Built from `native/` on the target machine; not carried in git |
| bash | Bundled payload (`@dsh-ops/bash-win32-x64`) | The operator's own bash, selected with `bashPath` |
| PowerShell 7 | Bundled payload (`@dsh-ops/pwsh-win32-x64`) | The plugin can provision it, but the host exposes no pwsh row on macOS |

The worker binary is not part of the repository on either platform: upstream
ships `runtime/` through the `files` whitelist in `package.json`, and
`.gitignore` keeps it out of git. A source checkout has to stage its own worker.

## What changes on macOS

| Area | Upstream behaviour | This branch |
| --- | --- | --- |
| Package scope | `os: ["win32"]`, `cpu: ["x64"]` | `["win32","darwin"]`, `["x64","arm64"]`; `@fastctx/darwin-arm64` added as an optional dependency |
| Worker resolution | `PLATFORMS = ['win32-x64']` | `['win32-x64', 'darwin-arm64']` |
| Profile commands | Reject any host other than win32-x64 | Accept win32-x64 and darwin, and discover the desktop application's CLI per platform |
| Shell file names | `bash.exe` / `pwsh.exe` at every layout | `shellExecutable(kind, platform)`: the `.exe` name on Windows, the bare name elsewhere |
| System discovery | Windows well-known locations only | Adds the Homebrew and system locations used on macOS and Linux |
| Shell pins | PortableGit and PowerShell for win32-x64 | Adds a digest-pinned PowerShell 7.6.6 `tar.gz` for darwin-arm64 |
| Archive extraction | `zip` and `sfx-7z` | Adds `tar.gz`, unpacked with the system `tar` |
| pwsh overlay | Mounted on Windows only | Gated by `shells.pwsh.available` alone; see the capability matrix |

The Windows branches keep their previous values: the new helpers derive a file
name or a target from `process.platform`, and the two Windows pins are
unchanged.

## Building the native worker

Rust >= 1.88 is required, the same requirement as `npm run build:ptc`. The crate
is platform neutral, and its Windows-specific code sits behind
`#[cfg(windows)]`.

```console
cargo build --release --manifest-path native/Cargo.toml
node bin/native-runtime.mjs stage --platform darwin-arm64
node bin/native-runtime.mjs check --platform darwin-arm64
```

`stage` copies the worker into `runtime/darwin-arm64/` and writes its receipt
(`version`, `target`, `executable`, `sha256`). `check` verifies the Mach-O
header and every digest. `resolveWorker` reads that receipt on each load, so a
worker built from different source fails closed instead of running.

## Configuration

macOS carries no bundled shell payload, so the bash rung has to be selected
explicitly. `bashPath` is the first rung of the resolution ladder and only
checks that the path exists:

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    bashPath: /opt/homebrew/bin/bash
- id: dsh-ops-background
  name: dsh-ops/background
  disabled: false
  config:
    enableShellTools: true
    bashPath: /opt/homebrew/bin/bash
```

Two details matter:

- **Each component resolves its own row's configuration.** A `bashPath` set only
  on `dsh-ops/shell` leaves `dsh-ops/background` without a resolvable bash: its
  four tools are never published and nothing reports an error. Repeat the key on
  every row that needs bash.
- **The background component also needs FastCtx**, which is resolved from the
  plugin's own `node_modules`. That is why `@fastctx/darwin-arm64` is an
  optional dependency of this package rather than a choice made in a profile.

`allowSystemShellFallback: true` is not a substitute for `bashPath`: it selects
an unpinned system shell, and the first-start migration writes it back to
`false`.

Installing a source checkout into a profile can use the official profile
manager directly, for example `dsh plugin --profile <name> add <path>`, or the
one-command entry point with
`DSH_OPS_INSTALL_SPEC=<package spec> dsh-ops install --profile <name>`.

## Capability matrix

| Component | macOS arm64 | Notes |
| --- | --- | --- |
| `dsh-ops/file` | Available | Requires the staged `runtime/darwin-arm64/dsh-ops-worker`. 0.3.0 has no FastCtx fallback for this component, so a missing worker removes all four tools without reporting an error. |
| `dsh-ops/shell` | Available | Requires `bashPath`. The host's `bash-sandbox` row is enabled on macOS, so confined modes keep host enforcement. |
| `dsh-ops/background` | Available | Requires `bashPath` on its own row and `@fastctx/darwin-arm64`. Its tools are published per session and only under `danger-full-access`. |
| `dsh-ops/ptc` | Not verified on macOS | The component is opt-in and loads only in a pure PTC session. The worker builds for darwin-arm64, but no macOS host has been verified to present that session mode. |
| PowerShell 7 (`pwsh`) | Not available on macOS | `dsh-ops provision-shells --pwsh` installs the pinned 7.6.6 build and the ladder reports it as available, but the host's `pwsh-sandbox` and `tool-pwsh` rows are disabled outside Windows, so no pwsh tool appears. |

## Known limitations

- **`/tmp` is a symlink on macOS** (`/tmp` -> `/private/tmp`). The native file
  worker refuses to traverse links, so the file tools reject paths below it with
  `POLICY_DENIED: Links, reparse points and special objects are not traversed`.
  Pass the canonical path (`/private/tmp/...`) instead. This is the intended
  no-follow behaviour, not a defect.
- **Replacing already-loaded code needs a host restart.** Editing a profile
  patch file re-reads the bundle's composition and can remount or unmount a
  component, but the host has already imported the plugin's modules: a package
  swap keeps executing the old code until the application restarts.
- **The worker is not in git**, so a clone of this repository cannot run the
  file component until the build step above has been run once.
