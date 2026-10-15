# dsh-ops 0.3.1 — Linux x64 适配与原生 worker 边界修复

## 发布范围

- 平台声明与 `0.3.0` 相同：**Windows x64 与 Linux x64**，目标宿主 DSH `0.2.0-rc.2`。
- 本版把 Linux x64 从「声明支持」推进为「实测平台」：同一批测试套件、发布闭包与出厂 tarball 在 Linux x86_64 实机上跑通，这些运行暴露的缺陷在本版修复。修复本身与平台无关，Windows 同样受益。
- macOS 与 ARM64 不在支持范围；不能把历史编译检查当作实机支持。shell 组件（`ops_bash`/pwsh）及其 Bash IPC 代理仍仅 Windows。
- `dsh-ops` 主包更新为 `0.3.1`；三个 Windows 可选载荷依赖仍固定 `0.2.1`，无需重复发布。

## Linux 适配了什么

- **原生 worker**：`x86_64-unknown-linux-gnu` 上 `cargo build --release --locked`、`cargo test`、完整 `npm run verify`（`DSH_OPS_REQUIRE_RUNTIME=1` 下 25 个套件全过、0 跳过）与 `npm run verify:release` 全部实机通过。
- **平台分支而非兼容层**：POSIX 侧走目录 `fsync` 与元数据重放，Windows 侧保持 `MoveFileExW`；同一份 Rust 代码用 `cfg` 分开，不做「两边都能跑」的折中。
- **测试与发布校验按平台推导**：挂载点与文件系统夹具在运行时解析，不解析依赖 `LC_MESSAGES` 的工具措辞，整套跳过按平台显式声明（Linux 上 2 个）且从不计为通过。
- **发布闭包**：只闭合本包实际 stage 的目标，因此只构建 Linux 的机器同样通过；要声明「发布包必须齐平台」设 `DSH_OPS_REQUIRE_ALL_TARGETS=1`。闭包信息点明当前 checkout 实际 stage 的平台，不再假定 Windows。
- **文档**：[Linux 构建与验证](linux构建.md)（[English](linux-build.md)）覆盖 build → stage → `npm pack` → `dsh plugin add ./dsh-ops-0.3.1.tgz` 全流程与门禁预期输出。
- **新增 11 个边界套件**，两个平台都跑：grep 跨行、替换元数据、输出字节预算、更新锁、hex 偏移、参数与运行时诊断、发布作用域、PTC 溯源、Linux 参数/属性。见 `test/`。

## 修掉的原生 worker 缺陷

- **替换丢失文件身份**：`ops_replace` 发布的是新 inode，原先不读旧文件元数据 —— `0600` 的 `.env` 变 `0664` 全局可读、`0755` 脚本丢可执行位、ACL 与 xattr 一并消失。现在发布前捕获并重放 mode/owner/POSIX ACL/xattr，`items[].metadata` 报告保留了什么；mode 或 ACL 重放失败即不发布，owner 与其余属性重放失败进 `metadataWarnings`。
- **`multiline` 无法跨行**：含 `\n` 的模式永远 0 匹配且不报错。现在整份文本匹配，`^`/`$` 仍按行；并修掉末尾换行之后多报一个不存在的第 N+1 行。
- **读取只按行数设界**：单行超长的文件让「读」整体失败。现在按编码字节与行数双重设界，并报告 `bytesTotal` / `truncatedInLine`；hex 视图不再丢掉文件第一行。
- **并发替换静默丢更新**：`revision` 守卫是 check-then-act 竞态，多个调用都报成功而只有最后一次存活。现在整个 read-check-publish 窗口持有排他锁，对端收到 `REVISION_CONFLICT`。
- **硬杀残留隐藏临时文件**：下次写同一文件时回收自己的 `.<name>.dsh-ops-*` 残骸（此刻持锁，安全）；rename 成功之后目录 `fsync` 失败改为 `effectState: "applied"` 并说明不要重试。
- **参数契约**：`maxReplacements` 触顶的报错原先把责任推给 pattern，现在点名命中数、上限与如何提高；`replace` 的 `pattern` 是字面量而 `grep` 的同名字段是正则，两者补上了从未有过的字段说明（行为不变）。
- **诊断**：worker 无执行位时按路径与 mode 拒绝，而不是等到 `spawn` 报裸 `EACCES`；`unavailable` 列出尝试过的候选路径；缺失/畸形 receipt、半暂存目录、缺平台各有明确报错与出路。

## 安装与注意

从官方 npm registry 或 DSH 插件市场安装 `dsh-ops@0.3.1`；替换旧版后正常退出并重启 Desktop。
无需 Rust/MSVC：发布包携带 Windows x64 与 Linux x64 worker、Windows IPC 代理、receipt 和匹配源码。
PTC 组件需显式启用，使用纯 PTC-only 呈现；后台组件仍默认关闭、仅限完全权限。
首次受限 Bash 调用会在 DSH_HOME 内建立私有载荷副本，有一次磁盘复制成本；之后复用同一校验身份（仅 Windows）。
Windows 宿主仍报告 `partial` enforcement，本插件不将其冒充完整内核隔离。
不匹配的自定义/升级 MSYS DLL 会拒绝兼容执行，不绕过沙箱。
Linux 侧不提供 bash/pwsh 与 Bash IPC 代理，依赖它作为执行通道的后台组件在 Linux 上不可用。

## 发布验证

- Manifest、源码测试、真实 Windows x64 与 Linux x64 DSH provider、真实 Node PTC SDK command/script/pipeline 和权限切换测试。
- Linux x86_64 实机：`DSH_OPS_REQUIRE_RUNTIME=1 npm run verify` → 25 个套件全过、0 跳过；`npm run validate:manifest` → 58 项全过；`npm run verify:release` → 发布闭包 OK；`npm pack` 出的 tarball 解包后 receipt sha256 与二进制一致、可执行位在、替换保留 mode/ACL/xattr、跨行 grep 正确。
- `npm run verify:release` 核验声明作用域与 `PLATFORMS` 一致、已 stage 目标的 worker PE/ELF 与 version/hash，并在包内携带 `win32-x64` 时核验 IPC 二进制与源码 hash 闭包。
- GitHub Release 为源码/tag/说明；随后生成 npm tarball，核验包内容、凭据排除、哈希与独立安装。
- npm 发布由维护者使用本机 `dist/publish.bat` 执行，不由 Actions 自动发布。GitHub Actions 保持既有关闭状态。

## 仍未闭合

- `ops_replace` 在 Windows 上重建 inode 时同样会丢安全描述符（DACL），需要用 `ReplaceFileW` 或显式复制 DACL；缺 Windows 实机数据，逐条清单见 [Windows 验证清单](windows-verification.md)。
- 元数据「重放失败」分支、发布后 `fsync` 失败、`metadataWarnings` 三类路径在门禁里拿不到（需要特定文件系统或非特权上下文），由代码阅读守住，已在套件文件头注明。
- macOS/ARM64 未验收；Linux x64（`x86_64-unknown-linux-gnu`）的 file 与 PTC 验收来自同一批测试套件在本机的运行结果。也不把用户特定任务的 token 统计当作通用性能保证。
- 历史 PortableGit 载荷的完整 source-delivery 闭包限制见 [PROVENANCE](../PROVENANCE.md)；本插件不分发修改后的 MSYS DLL，私有修改仅在用户本机生成。
