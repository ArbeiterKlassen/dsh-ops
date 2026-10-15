# 在 Linux x64 上构建与运行 dsh-ops

Linux x64 是 **file**、**ptc**、**background** 三个组件的受支持目标。**shell**
组件（`ops_bash`、随包 PowerShell 7、bash IPC 代理）仍仅限 Windows x64 —— Linux
上没有可发布的随包 bash，插件也不会假装有。

Linux 上**没有任何东西随安装包下载**：原生 worker 一律由本地源码构建后落到安装相对
目录，这正是本文档存在的原因。npm 包仍然只携带 Windows x64 载荷
（`@dsh-ops/*-win32-x64`），Linux 没有对应的载荷包可取。

| 组件 | Linux x64 | 说明 |
| --- | --- | --- |
| `dsh-ops/file` | 支持 | 4 个工具：`ops_inspect_local_file`、`ops_grep`、`ops_glob`、`ops_replace` |
| `dsh-ops/ptc` | 支持 | `ops_batch`、`ops_result`；须显式启用 |
| `dsh-ops/background` | 支持，但需要一个 bash | job 工具受"可解析的 bash"约束，见下文 |
| `dsh-ops/shell` | 不支持 | `ops_bash` 与 pwsh 仍仅限 Windows x64 |

## 前置条件

| 依赖 | 版本 | 依据 |
| --- | --- | --- |
| Node.js | `^22.19 \|\| >=24` | `package.json` 的 `engines` |
| Rust | `1.88` 或更高（`cargo`） | `native/Cargo.toml` 与 `vendor/fastctx/Cargo.toml` 的 `rust-version` |
| pnpm | 近期版本即可 | `dsh plugin` 会转发给它 |
| DSH | `0.2.0-rc.2` | 本版目标宿主 |

## 1. 取源码

```console
$ git clone https://github.com/T-Auto/dsh-ops.git
$ cd dsh-ops
```

## 2. 安装依赖

```console
$ npm install
added 45 packages in 499ms
```

根包的 `os` 已声明为 `["win32", "linux"]`，因此 npm 在 Linux 上不会施加平台否决。
若你手上的树其 `os` 仍是 Windows-only（例如已发布的 0.3.0 tarball），同一条命令会在
`EBADPLATFORM` 停下，已发布的 `npx dsh-ops@latest install` 入口在 Linux 上也不可用。
与 tarball 如何发布无关、始终可用的路径见
[第 6 节：安装进 profile](#6-安装进-profile)。

确实需要把 Windows-only 的树强行装上时，`npm install --force` 可以做到；注意它同时会
跳过 npm 的脚本闸门。有三个依赖带 install 脚本（`node-pty`、`koffi`、
`@deepseek-ai/dsh-subprocess-local`），需要它们的测试套件会明说，而不是静默通过。

## 3. 构建原生 worker

```console
$ npm run build:ptc
toolchain: cargo 1.98.1
    Finished `release` profile [optimized] target(s) in 3.05s
linux-x64: 3665672 bytes, sha256 327420ad9660…f9c8b0efc9445c0c
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

该命令编译 `native/`，并把产物落到运行时解析器所读的安装相对布局：

```text
runtime/linux-x64/dsh-ops-worker
runtime/linux-x64/provenance.json
```

`provenance.json` 记录 target、包版本、可执行文件名与二进制的 SHA-256。
`resolveWorker()` 在**每一次**解析时重算该摘要，凭据不匹配就直接拒绝，因此半拷贝或
被手工改过的 `runtime/` 是 fail-closed，而不是照跑。

确认接线正常：

```console
$ node bin/dsh-ops.mjs status
```

## 4. 构建 FastCtx（仅 background 组件需要）

file 与 PTC 组件使用自己的 Rust worker，**不需要** FastCtx。只有
`dsh-ops/background` 需要，所以这一步是可选的。

```console
$ cargo build --release --locked --manifest-path vendor/fastctx/Cargo.toml
    Finished `release` profile [optimized] target(s) in 2m 33s
```

产物位于 `vendor/fastctx/target/release/fastctx`。两种指认方式：

```console
$ export DSH_OPS_FASTCTX_BIN="$PWD/vendor/fastctx/target/release/fastctx"
```

或写进 profile 行：

```yaml
- id: dsh-ops-background
  disabled: false
  config:
    binaryPath: /absolute/path/to/fastctx
    enableShellTools: true
```

`resolveBinary()` 依次搜索：托管运行时、vendored 构建、本包自带的平台包、已发布的
`@fastctx/<platform>-<arch>` 包、`PATH`。找不到时它会**列出它试过的每一级**，所以缺
运行时永远不会是一桩无头悬案。

## 5. 在本机验证

门禁有三种结果 —— 通过、失败、跳过 —— 且**跳过永远不计入通过**。
`DSH_OPS_REQUIRE_RUNTIME=1` 会把跳过变成失败，这是最严格的形式：

```console
$ DSH_OPS_FASTCTX_BIN="$PWD/vendor/fastctx/target/release/fastctx" \
  DSH_OPS_REQUIRE_RUNTIME=1 npm run verify
…
dsh-ops test: 20 suite(s) passed in 11s
```

没有 FastCtx 构建时，同一条命令会少跑两个套件，并明确列出跳过项：

```console
dsh-ops lifecycle: skipped (no FastCtx executable found; …)
dsh-ops mount: skipped (no FastCtx executable found; …)
dsh-ops test: 18 suite(s) passed, 2 skipped in 7s
```

Rust worker 自身的 barrier 测试：

```console
$ cargo test --release --locked --manifest-path native/Cargo.toml
test result: ok. 1 passed; 0 failed
```

### Linux 边界套件

有六个套件绕过宿主桥接层，直接驱动发布的 worker，专测那些会被桥接层归一化掉的边界。
它们在 `test/linux-*.test.mjs`，共用 `test/lib/boundary.mjs`：

| 套件 | 主题 |
| --- | --- |
| `linux-paths` | 怪异与 CJK 文件名、名称/NUL 长度上限、深度、符号链接拒绝 |
| `linux-args` | `offset`/`limit` 边界、glob 模式、正则安全性、上下文上限、分页是否诚实 |
| `linux-sandbox` | `read_only`、`write_roots` 围栏、符号链接拒绝、特殊对象 |
| `linux-protocol` | 畸形帧、超大请求、重复调用、并发原子性 |
| `linux-attributes` | 内容/mtime/无残留、硬链接 inode 替换、`0444`、稀疏文件 |
| `linux-scope` | 平台闸门、provenance 篡改与伪造、三层作用域、已 stage 摘要 |

它们被写成「Windows 上绝不会把 Linux 专属检查报成通过」：`linux-attributes` 整套
跳过，`linux-paths` 与 `linux-sandbox` 就地守护其 POSIX 专属用例，其余三个与平台无关。
**已知未修缺陷是刻意不写断言的**，这样修好一个不会反而让闸门变红；每个套件的文件头都
列明了它留空的是哪一条。仍需 Windows 宿主回答的问题见
[Windows 验证清单](windows-verification.md)。

### 在 Linux 上回答「发布闭包」问题

`npm run verify:release` 在上面的门禁之上再加发布闭合检查。它从 `package.json`
推导声明的作用域，断言它与解析器的 `PLATFORMS` 完全一致，然后校验**本包实际
stage 的**目标。在只构建 Linux 的机器上那就是 `linux-x64`，而 Windows 的 IPC 闭包
会被明确报告为跳过，而不是被悄悄略过：

```console
$ npm run verify:release
…
dsh-ops test: 20 suite(s) passed in 11s
linux-x64: 3665672 bytes, sha256 327420ad…
Release closure OK: dsh-ops@0.3.0, linux-x64 worker (Bash IPC closure skipped: win32-x64 is not staged; DSH_OPS_REQUIRE_ALL_TARGETS=1 demands it).
```

`npm run check:ptc-runtime` 回答的是更窄的问题 —— 已 stage 的运行时是否完好 ——
所以它在单平台构建上同样通过：

```console
$ npm run check:ptc-runtime
linux-x64: 3665672 bytes, sha256 327420ad…
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

不带参数的 `node bin/native-runtime.mjs check` 仍然要求**每个**已声明平台都在场，
因为那是发布装配脚本在发布之前要问的问题。组装跨平台发布版、希望缺平台即失败时，
设 `DSH_OPS_REQUIRE_ALL_TARGETS=1`。

## 6. 安装进 profile

`npx dsh-ops@latest install` 是文档里的 Windows 路径，依赖一个 Windows-only 的 npm
tarball。在 Linux 上，请通过 DSH 自己的插件管理器从检出目录安装，它会转发给 pnpm：

```console
$ dsh plugin --profile <profile> add /absolute/path/to/dsh-ops
```

要安装别处已经建好的构建，先打包（`files` 列表包含 `runtime/`，因此已 staged 的
worker 会随 tarball 一起走）：

```console
$ npm pack
$ dsh plugin --profile <profile> add ./dsh-ops-0.3.0.tgz
```

确认宿主到底合成了什么：

```console
$ dsh --profile <profile> --dump-config
```

## 配置 shell 通道

Linux 上插件不发布 bash 也不发布 PowerShell，因此 `shell` 组件无物可给，
`background` 组件的 job 工具（`ops_run_background`、`ops_job_output`、
`ops_job_list`、`ops_job_kill`）也保持不发布。这是 fail-closed，不是缺陷：
`FastCtxTools.shellAllowed()` 在无可解析执行器时会拒绝提供命令面。

要拿到这些工具，显式指定 bash：

```yaml
- id: dsh-ops-background
  config:
    bashPath: /usr/bin/bash
```

> **`allowSystemShellFallback: true` 不起作用。** 启动期的配置迁移会有意把这个键改回
> `false` —— 它是安全姿态降级（使用未固定摘要的系统 shell），迁移不会让部署静默滑进去。
> `bashPath` 是受认可且显式的替代品，而且配置的路径是权威的：它胜过 `PATH` 与随包布局。
>
> 受限模式下同样如此：`workspace-write` 与 `read-only` 的 confinement 会拒绝摘要未被
> 固定的 MSYS 形态 bash，所以请把 `bashPath` 指向普通的系统 bash，交由 DSH 沙箱去约束它。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Unsupported runtime target linux-x64` | 该构建的 `PLATFORMS` 列表早于 Linux 支持 | 换用列出 `linux-x64` 的版本，或用已支持的检出构建 |
| 编译成功后 `build:ptc` 报 `Error: Unsupported target` | stage 步骤拒绝了该 target | 同上；编译本身没有问题 |
| `npm error code EBADPLATFORM` | 已发布的 tarball 声明 `os: ["win32"]` | 从检出目录（或 `npm pack`）经 `dsh plugin` 安装 |
| file 工具无声消失、没有任何报错 | `resolveWorker()` 抛错后组件降级，而 `required` 缺省为 `false` | 给 `dsh-ops/file` 行设 `required: true`，让它变响 |
| `preflight` 阶段报 `Bad file descriptor (os error 9)` | 审计库或原子替换对 cap-std 在 Linux 上以 `O_PATH` 打开的目录句柄执行 `fsync`，内核拒绝 | 已在 `native/src/lib.rs` 修复；用 `npm run build:ptc` 重建 |
| 被拒命令报成普通失败而非 `POLICY_DENIED` | 宿主提供的英文拒绝签名去匹配被本地化的 libc 消息 | bash 通道已固定 `LC_MESSAGES=C`；旧构建在非英文宿主上会命中此问题 |
| job 工具始终不出现 | 没有可解析的 bash | 设置 `bashPath`，见上文 |

## 为什么要本地构建

npm 包只发 Windows x64 载荷。因此 Linux 部署没有可回退的已下载 worker，而插件的运行时
解析在设计上就是安装相对的：它不会静默地从无关位置捡一个二进制来用。从检出目录构建是
受支持的路径，而它产出的每一件产物在运行前都会经过摘要校验。
