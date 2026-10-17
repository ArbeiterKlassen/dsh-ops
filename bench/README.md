# dsh-ops 端到端 Token Benchmark

> 本文是这套 harness 的说明：接口事实、方法论、门禁口径都在这里。
> 状态：harness 已落地并进门禁（`node test/run.mjs bench`，本机 60 项检查全绿；
> 管道受限的环境里 stub 端到端那几项会自我跳过并说明原因，数目因此随环境浮动）；
> 步骤 6–10 的**真机实测**还差一台能连 OpenAI 兼容服务器的 Windows x64 机器。

这里测的是**真实模型跑真实任务时的 token 消耗**，不是 schema 字节估算。
主要对比场景：无插件基线（stock `dsh-base` 工具面）vs 装了 dsh-ops 的候选；
同一套 harness 也能比"旧版 dsh-ops vs 新版"（换 profile 里安装的插件版本即可）。

```console
node bench/run.mjs --label bench-base --profile bench-base
node bench/run.mjs --label bench-ops  --profile bench-ops
node bench/compare.mjs bench-base bench-ops --fail-on both
```

label 与 profile 同名：run 目录因此是 `bench/runs/<当天>/<UTC 时间戳>-bench-base` 和
`bench/runs/<当天>/<UTC 时间戳>-bench-ops`，翻 `bench/runs/` 不用先猜哪个 label 是哪一侧。
同一侧换插件版本再跑时（"旧版 vs 新版 dsh-ops"）另起一个 label 就行，例如 `--label ops-0.3.1`。

不传 `--folder` 时，run 自动归到**本地当天日期**的组目录 `bench/runs/2026-10-16/` 下（目录按需创建）：
一天的跑分就是一只架子，`bench/runs/` 不再被历次 sweep 摊平堆满。run 目录名里的时间戳仍是 UTC，
变的只是外面那层架子；`compare.mjs` 不传 `--folder` 时会在 `bench/runs/` 根目录**及其下一级各组**里
按 label 取最新，所以同日两侧直接比就行，不用多写参数。

要按实验或版本命名一轮（不同实验、不同版本、重测），给同一轮的两侧都加同一个 `--folder <名称>`：
run 目录落在 `bench/runs/<folder>/<UTC 时间戳>-<label>/`。folder 同样自动创建、可反复复用，
比较时给 `compare.mjs` 也传同一个 `--folder`，label 只在该组内解析，
别的轮次的同名 label 干扰不进来：

```console
node bench/run.mjs --label bench-base --profile bench-base --folder ops-0.3.1
node bench/run.mjs --label bench-ops  --profile bench-ops  --folder ops-0.3.1
node bench/compare.mjs bench-base bench-ops --folder ops-0.3.1 --fail-on both
```

不传 `--repeat` 时按语料的分层预算跑（每任务 2 次，见 §4.2）；显式 `--repeat N` 会统一覆盖。

第一次在新机器上跑，**加 `--verbose`**；§4.1 把现场日志的每一行都解释了，`--preflight-only`
则是花 200ms（不花 token）先问一句"这台机器和这个 profile 到底行不行"。

入口分两种：一次性准备有 npm 快捷方式 `npm run bench:setup`（等价于 `node bench/setup.mjs`，
参数照 `npm run bench:setup -- --dry-run` 这样透传）；`run.mjs` / `compare.mjs` 仍**不挂** npm
script（`bench/` 是仓库自己的测量工具，跑分这些一次性命令不值得占发布包的主干入口），直接
`node bench/run.mjs …` / `node bench/compare.mjs …`。想要更短的命令，在自己的 shell 里起别名即可。
跑分脚本的门禁照旧走主干测试：`node test/run.mjs bench`（或 `npm test`，它会按名字选中
`test/bench.test.mjs`）。

上面三行有两个前提：**在 `cmd.exe` 里跑**（§1 的终端条件），以及**基线已按 §2.1 钉在 Windows
PowerShell 5.1**。前者 preflight 现在会自己查（`PSModulePath` 顺序 + 一条 warning，`--strict`
直接拒绝开跑，见 §4.1）；后者是"数字在比什么"的问题，preflight 不看——钉没钉成功要翻
`dump-config.txt` 里那行 `pwshPath`。

---

## 1. 前置条件（`run.mjs` preflight 会逐项自检）

- `@deepseek-ai/dsh@0.2.0-rc.2` 已全局安装（`npm i -g @deepseek-ai/dsh`）；
- **pnpm 在 PATH 上**：`dsh plugin` 透传 pnpm，缺失时 exit 127（PLAN §2.3）；
- node 满足 `engines`（`^22.19 || >=24`），**PATH 上的 `node` 也要满足**：
  verify 用的是 run.mjs 自己的 `process.execPath`，任务里模型自跑 `node test.js` 用的是
  PATH 上的 `node`，两者都记录进 `summary.json`（PLAN §10.6）；
- OpenAI 兼容服务器在线，且**流式响应回报 usage**（`stream_options.include_usage`），
  否则拿不到 token 结论（PLAN §2.6，见下面冒烟）；
- **启动终端最好用 `cmd.exe`（或 Windows PowerShell 5.1），不要用 PowerShell 7**：pwsh 7 把自己
  的 `$PSHOME\Modules`（可能正是 dsh-ops 自带的 `pwsh-win32-x64\bin\Modules`）排在 `PSModulePath`
  最前并逐代传给子进程，而 dsh-ops 的工作区准备脚本是 **Windows PowerShell 5.1** 执行的。5.1 自动
  加载 `Get-Acl` 时会被那份 Core-only manifest 抢走 → 模块导入失败 → 准备脚本 exit 1 →
  `pwsh` / `bash` / `run_code` 在模型命令跑起来之前就全灭，报
  `DSH workspace preparation failed (not a user permission denial)`。

  **这条现在由插件自己根治**（`lib/workspace-preparation.js`）：准备子进程拿到的是一份净化过的
  `PSModulePath` —— 排在 in-box 根之前、且真的带 `Microsoft.PowerShell.Security` 的 Core 根被摘掉，
  其余条目的顺序原样保留；所以候选侧不会再因为"从 pwsh 7 终端启动"而整轮作废。换回 `cmd.exe` 仍
  有两条理由：profile 里装的可能是**没有这条修复的旧版** dsh-ops（`--reinstall` 可更新），以及口径
  一致性——preflight 照旧把污染打成 warning（`--strict` 直接拒绝），`meta.json` 记下探测结果。自检：

  ```console
  node -p "process.env.PSModulePath.replace(/;/g,'\n')"
  ```

  只要 `...\PowerShell\7\Modules` 或 `...\@dsh-ops\pwsh-win32-x64\bin\Modules` 出现在
  `C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules` **之前**就是被污染了。`cmd.exe` 的
  `PSModulePath` 取自注册表 Machine/User 两层，出厂就是干净的；需要就地洗的时候，在**这一个**
  cmd 窗口里
  `set PSModulePath=%SystemRoot%\system32\WindowsPowerShell\v1.0\Modules;C:\Program Files\WindowsPowerShell\Modules`，
  代价是这个窗口里起来的 shell 都读不到用户级模块，别写进任何长期环境。

必须在**普通终端**里跑：harness 通过管道读 `dsh --json` 的 stdout。被沙箱约束的
agent 会话里管道 spawn 会被拒（`EPERM`），preflight 会直接报出这条原因。

## 2. 一次性准备

一条命令做完 profile 创建 + 基线钉版本 + 候选装插件 + 回读验证；幂等，可以反复跑：

```console
node bench/setup.mjs --dry-run   :: 只看计划：每个写入和每条命令都印出来，什么都不改
node bench/setup.mjs             :: 就是 npm run bench:setup；带参数写 npm run bench:setup -- --dry-run
```

它做的事，以及出问题时你要看的地方：

| 步骤 | 行为 | 相关开关 |
|---|---|---|
| 建 profile | 不存在才执行 `dsh <name> --from-default-profile headless`（这条命令本身不幂等，脚本替你判断） | `--base-profile` / `--cand-profile` / `--template` |
| 钉基线 shell | 把 `pwshPath` 写进 bench-base 自己的 patch 层，再用 `--dump-config` 回读确认（理由见 §2.1） | `--pin-shell` / `--no-pin` / `--force` |
| 钉权限模式 | 把 `sandbox-policy.mode` + `approval.policy` 写进**两侧各自**的 patch 层，再用 `--dump-config` 回读确认（理由见 §2.2） | `--permission-mode` / `--no-permission-mode` / `--force` |
| 装候选插件 | `dsh plugin --profile bench-ops add dsh-ops@<本仓库版本>`；已装就跳过 | `--plugin <spec\|local\|none>` / `--reinstall` |
| 环境体检 | `PSModulePath` 污染（§1）、home 层 patch（§6）、`llm.patch.yml` 缺失，都在最后打出来 | — |

`--plugin local` 装的是当前 checkout 的 pnpm `file:` **快照**，改完代码要 `--reinstall` 重装，
否则测的还是旧快照（"旧版 vs 新版 dsh-ops"就是靠这个开关加 `--reinstall`）。
用隔离 home 的人把 `--dsh-home` 一起带上：`node bench/setup.mjs --dsh-home D:\bench\dsh-home`。

脚本跑不通时的手工等价步骤：

```console
:: 1) 创建两个 profile（只初始化、不跑任务；不幂等——已存在时重跑会报错）
dsh bench-base --from-default-profile headless --dump-config >NUL
dsh bench-ops --from-default-profile headless --dump-config >NUL

:: 2) 候选 profile 安装被测插件（可复现性优先 published 版本或 npm pack tarball；
::    本地目录是 pnpm file: 快照拷贝语义，checkout 改动后要重装）
dsh plugin --profile bench-ops add dsh-ops@0.3.0
```

基线那条 `pwshPath` 的手工写法在 §2.1 末尾。

LLM endpoint **不手工改 profile 的 `cordis.patch.yml`**，改用 `--patch` overlay：
`run.mjs` 会把同一份 `bench/llm.patch.yml` 注入每一次 dsh 调用（含 `--dump-config` 存档），
两侧 provider/model 一致由构造保证（PLAN §2.7）。

```console
:: 3) 复制模板并填写服务器与模型
copy bench\llm.patch.example.yml bench\llm.patch.yml

:: 4) API key 只放环境变量（patch 文件里只有变量名；密钥不进任何仓库文件）
setx BENCH_SERVER_API_KEY "sk-..."
```

### 2.1 基线为什么必须钉在 Windows PowerShell 5.1

`node bench/setup.mjs` 会自动钉并回读确认；下面是"为什么"和手工兜底。

不钉的话**两侧都是 PowerShell 7**，量的就不是"Windows 原装标准模式"。宿主 `pwsh` 工具解析可执行文件
的顺序是：显式 `pwshPath` → `C:\Program Files\PowerShell\7\pwsh.exe` → **扫 PATH 找 `pwsh.exe`** →
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 兜底。Windows 出厂就把
`%LOCALAPPDATA%\Microsoft\WindowsApps`（里面躺着一个 0 字节的 Store pwsh 执行别名）放进 User PATH，
5.1 那一档永远轮不到 —— 实测不钉时基线跑的是 Store 版 7.6.7，候选侧跑的是插件自带的 7.6.6，
只差一个小版本加有无插件。

编辑 `%USERPROFILE%\.dsh\profiles\bench-base\cordis.patch.yml`，把末尾那行 `[]` 换成：

```yaml
- id: pwsh-sandbox
  config:
    pwshPath: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe
```

验证（不跑模型、不花钱）：

```console
dsh bench-base --patch bench\llm.patch.yml --dump-config | findstr /n pwshPath
```

必须打印出 `pwshPath: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`。候选侧什么都不用做：
装了 dsh-ops 之后插件在运行时给同一个 `pwsh-sandbox` 注入 `pwshPath`（指向它自带的
`node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe`），卸载即还原，profile 文件里不留痕迹。

三条注意：

- 这是**唯一允许手工改 profile 文件**的步骤，LLM endpoint 照旧走 `--patch` overlay。别把 `pwshPath`
  放进 `bench/llm.patch.yml`：那是两侧共用的层，候选侧会被插件的运行时注入抢回去，于是
  `dump-config.txt` 存档写着 5.1、实际跑的是 7 —— 存档与实况不一致，比没钉更难查。
- `pwshPath` 是**照原样使用**的：不校验存在、失败也不回退。写错一个字符 = 每次 `pwsh` 调用都 spawn 失败。
- 钉完**基线要重跑**：shell 引擎换了，旧 run 目录与新口径不可比。`compare.mjs` 按 label 后缀匹配、
  多个命中取最新。label 现在与 profile 同名（`bench-base` / `bench-ops`），所以早先那批以
  `-base-stock`、`-cand-ops` 结尾的 run 目录不会再冒充新基线；要拿旧数据对比，就把那个 run 目录直接传给 `compare.mjs`。

### 2.2 权限模式为什么也钉在 profile 里

`dsh-base` 组合里 `sandbox-policy.mode` 读的是 `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
而这行 `!!js` 是**每次运行组合配置时**才求值的：`set DSH_PERMISSION_MODE=...` 只对当前窗口里起的
进程有效，建 profile 那一刻设过什么也不会被记住。要固化只能写进 profile 自己的 patch 层——
`node bench/setup.mjs` 默认就把两侧都钉到 `danger-full-access`，然后用 `--dump-config` 回读确认。

为什么要钉：Windows 上 `workspace-write` 的受限令牌让候选侧的 `ops_replace` 在**落盘那一步**
拿到 `ACCESS_DENIED`（同一次调用的 dryRun、以及所有读操作都正常，宿主 `edit`/`write` 也正常），
换成全权限后同一个调用成功。于是在默认口径下，候选侧只能退回 `edit` 逐文件改——量到的不是
这个工具，而是它的退路。两侧钉同一个 mode 比较才仍然公平；`meta.json` 不记录 mode，
`dump-config.txt` 才是存档证据。

三条注意：

- **口径变了**：`danger-full-access` 不是 Windows 默认的 `workspace-write`，和别的口径跑出来的
  run 目录不能直接比。要退回默认口径用 `--permission-mode workspace-write`（代价是候选侧
  `ops_replace` 基本不可用），`--no-permission-mode` 则完全不动 profile。
- **approval 一起钉**：`dsh-base` 只在全权限下把 `approval.policy` 推成 `never`，其余模式是 `ask`；
  脚本按同样的规则写。别只手改 `mode` 而留着旧的 policy。
- **只写 profile 层**：和 `pwshPath` 一样不进 `bench/llm.patch.yml`——那是两侧共用的层，
  放进去等于两侧都被改，而存档却只证明了一侧。

## 3. 冒烟：先确认 usage 存在

**先做免费的那一步**：`--preflight-only` 只跑体检——不建 run 目录、不 spawn 任务、不花 token，
两三百毫秒就给出现场答案：

```console
node bench/run.mjs --preflight-only --profile bench-ops --verbose
node bench/run.mjs --preflight-only --profile bench-base
```

答案的内容：launcher 版本与它是怎么被找到的、profile 在不在、候选 profile 里装的是哪个 `dsh-ops`、
`pnpm` 在不在 PATH、`PSModulePath` 有没有被 PowerShell 7 抢在前头（§1）、overlay 的两个补丁 id
有没有落进组合树、`apiKeyEnv` 指的凭据从哪儿解析到（只报名字和来源，绝不打印值），以及**逐个
`baseURL` 的 TCP 连通性**（只做一次 connect、不发请求、不认证，所以不花 token；`--no-probe-endpoint`
可关）。不通就是一条 warning，`--strict` 直接拒绝开跑。正式跑分时同一套体检每次都会先做一遍。

正式测量之前，仍然要确认 `step_end` 事件带 `usage`。手工冒烟（只想看一条任务的时候）：

```console
mkdir %TEMP%\dsh-bench-smoke && cd /d %TEMP%\dsh-bench-smoke
dsh --profile bench-base --patch <repo>\bench\llm.patch.yml --json "Write the single word OK into ok.txt"
```

输出里 `{"type":"status","phase":"step_end",...,"usage":{...}}` 必须存在。没有就先去解决
服务器的 `include_usage`（vLLM / sglang / llama.cpp 各有开关）；harness 在缺 usage 时
只会统计步数与工具调用，并**拒绝给出 token 结论**（跑分过程中也会每一步打印一次
`model answered — in …`，缺 usage 的那一步立刻打出来）。

顺带确认两侧的 shell 引擎和候选侧的工作区准备都是活的（各一次调用，几百 token）：

```console
dsh --profile bench-base --patch <repo>\bench\llm.patch.yml --json "Use the pwsh tool to print exactly two lines: the value of $PSVersionTable.PSVersion.ToString(), then the Path property of (Get-Process -Id $PID). Put nothing else in your reply."
dsh --profile bench-ops --patch <repo>\bench\llm.patch.yml --json "Use the pwsh tool to print exactly two lines: the value of $PSVersionTable.PSVersion.ToString(), then the Path property of (Get-Process -Id $PID). Put nothing else in your reply."
```

期望基线报 `5.1.xxxxx` + `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`，候选报
`7.6.x` + `…\profiles\bench-ops\node_modules\@dsh-ops\pwsh-win32-x64\bin\pwsh.exe`。候选侧如果报
`DSH workspace preparation failed (not a user permission denial)`，那是 §1 的 `PSModulePath` 污染，
不是权限问题，也不是插件回归：本仓库版本的插件会在准备子进程里把抢在 in-box 根前面的那个 Core 根
摘掉，所以**先确认候选 profile 里装的是不是旧版**（`node bench/setup.mjs --plugin local --reinstall`），
再看 `runner.log` 里那行 stderr——它现在会被按本地代码页解码，是一句可读的中文，不再是一串乱码。
在没有这条修复的版本上跑出来的候选数据全部作废。

## 4. 日常跑分与对比

```console
node bench/run.mjs --list                        :: 打印任务语料
node bench/run.mjs --preflight-only --profile bench-ops :: 只体检，不花 token（§3）
node bench/run.mjs --dry-run --label x --profile x :: 只自检 fixture/verify，不 spawn dsh
node bench/run.mjs --label bench-base --profile bench-base
node bench/run.mjs --label bench-ops  --profile bench-ops --verbose
node bench/compare.mjs bench-base bench-ops --fail-on both --json bench\runs\compare.json
```

`run.mjs` 常用开关：`--task <id>`（可重复）、`--repeat N`（覆盖语料的分层预算）、`--timeout <ms>`、
`--dsh <path>`（显式指定 `lib/bin.js` 或可执行文件）、`--llm-patch <path>` / `--no-llm-patch`、
`--dsh-home <dir>`（隔离 DSH_HOME）、`--sleep-ms <n>`、`--verbose`、`--heartbeat-ms <n>`、
`--stall-ms <n>`、`--no-probe-endpoint`、`--preflight-only`（§3 的免费体检）、
`--strict`（preflight 警告升级为错误）、`--out <dir>`（直接点名 run 目录，等于不分组）、
`--folder <name>`（把本轮 run 归到 `bench/runs/<name>/` 下，目录自动创建、跨轮复用；缺省是本地当天
日期目录 `bench/runs/<YYYY-MM-DD>/`；与 `--out` 互斥）、`--keep`（保留临时工作区）。
完整列表见 `--help`。

### 4.1 现场日志：跑到哪了、通没通、卡在哪

跑分不再是一段黑屏。每个 run 从 spawn 那一刻就开始打印，**里程碑无条件打**（不开 `--verbose`
也能看清死活），细节只在 `--verbose` 下打；两种级别都完整落进 `<run>/runner.log`。

| 你会看到的行 | 它在回答什么 |
|---|---|
| `preflight: …`（launcher / profile / 候选插件版本 / pnpm / PSModulePath / overlay / credential / endpoint） | 机器与配置是否就绪；**连模型服务器通不通，在花钱之前就知道** |
| `[<task> r<n>] spawn provider X/model Y: <命令行>` + `pid=… timeout=…s workspace=…` | dsh 起来了没有、用的哪个 profile、超时多少 |
| `dsh booted — session … — startup OK` | 第一个事件到了：profile、插件、会话都是活的 |
| `step 0: request sent to the model …` | 请求发出去了（后面没动静，模型调用就是嫌疑人） |
| `model connection OK — step 0: model answered — in … / out … / cacheRead …` | **模型连上了、答了、usage 有回报** |
| `*** step N finished with NO usage …` | usage 缺失：第一次就喊，后面降级为细节 |
| `*** tool result error #N — …` | 工具在报错（前 5 次逐条打，之后只计数） |
| `*** dsh is writing to stderr — first line: "…"` | dsh 自己在报诊断（候选侧 workspace 准备失败走的就是这条路） |
| `still running 3m12s — 27 event(s), steps=2 …, last=step_start 41s ago` | 心跳（默认 15s，`--heartbeat-ms 0` 关掉）：没输出但仍在动 |
| `*** NO OUTPUT FOR 120s (last event: step_start) …` | 静默升级警告（`--stall-ms`，默认 60s；1×/2×/4×/8× 各一次） |
| `dsh exited 0 after 1m04s — 11 event(s), steps=1 …` / `*** TIMEOUT after 900s — … never got past "step_start"` | 结局；超时/失败还会附 `stderr tail` |
| `[1/15] csv-sum r0: exit=0 steps=1 tokens=… verify=PASS 64s` + 末尾 `verdict <label>: …` | 每 run 一行结果，以及整轮判定 |

判读顺序（"卡住了怎么办"）：

1. **连 `spawn` 都没有** → 卡在 preflight，看它最后打的那行。
2. 有 `spawn`、没有 `startup OK` → dsh 一个事件都没吐：**启动侧问题**（profile、插件没装、
   `pwshPath` 指错、`PSModulePath` 污染，见 §1）。日志里会写
   `not one event reached the stream`，并附 stderr 尾巴。
3. 有 `startup OK`、停在 `request sent to the model` → 模型调用没回来：对照 preflight 的
   endpoint 结论与 §3。
4. 心跳里 `steps` / `tool calls` 在涨 → 没卡，只是慢；只有 `last=… Xs ago` 一直涨才可疑。
5. 工具错误一路刷、每条都是 `DSH workspace preparation failed` → §1 的 `PSModulePath`：
   本仓库版本已经把它摘掉，所以这里见到它就说明候选 profile 里装的是旧版（`--reinstall`），
   或者准备脚本本身被拦（比如文件被标成 low integrity / 受限执行策略——那句报错现在会以
   可读的中文出现在 `runner.log` 里）。无论哪种，这一轮候选数据整体作废。

Ctrl-C 是**礼貌停止**：runner 杀掉 dsh 子进程及其进程树（不会留一个还在对着模型说话的孤儿），
结束当前 run，然后照常写 `summary.json` / `report.md` / `meta.json`，并在里面标上
`stoppedEarly: true`、`completedRuns` 与 `plannedRuns`——四次的样本冒充十二次这种事不让它发生。
再按一次 Ctrl-C 立刻退出，磁盘上已写的部分仍然都在。

`--preflight-only`（§3）是同一个体检的零成本版本：不建 run 目录、不 spawn 任务、不花 token。

`compare.mjs` 开关：`--aggregate median|min`（缺省 median）、
`--tolerance-pct <n>`（缺省 2）、`--fail-on regression|pass-drop|both|none`（缺省 both）、
`--regression-scope task|total|both`（缺省 task：逐任务对照容差，大任务的收益掩盖不了
别的任务回归；total 是旧的"只看 TOTAL 之和"行为，both 两个都判）、
`--json <out>`、`--runs <dir>`（换一份 runs 根目录）、`--folder <name>`（label 只在
`bench/runs/<name>/` 这一组里解析）。不传 `--folder` 时，label 会在 `bench/runs/` 根目录
和它下面一层的各组目录里按后缀匹配，多个命中仍取最新（按时间戳，跨组比较）；也可以直接传
run 目录或 `summary.json`。因此 `run.mjs` 默认的当天日期目录不用额外参数就能比；只想锁定某一天，
把日期当组名传进去即可：`node bench/compare.mjs bench-base bench-ops --folder 2026-10-16`。
usage 不完整时报告只出步数/工具计数，token 列打印 `n/a`，分桶明细整段省略。
报告里 TOTAL 行是语料总成本（体积加权），GEOMEAN 行是各任务 Δ% 的等权几何平均
（"整体效应"的无尺度读数），两个都打印。主表的 tokens、steps、tool calls 三列都给出
base→ops 与 Δ%；tool errors / pass 仍是原始对照。百分比按方向着色：**≤ 0 绿色**
（候选更省），**> 0 红色**（候选更贵）；缺失值保持 `n/a` 不上色。

主表之后紧跟 **Tool calls** 表：按工具名汇总两侧调用次数。`ops_*` 开头的工具集中排最前
（组内按 Ops 调用次数降序），其余工具随后也按 Ops 调用次数降序——插件自身工具的采用情况
一眼可见，没被 Ops 调过的工具排在最后；非 `ops_*` 工具只要在 Ops 列有调用数就标红
（说明 Ops 仍在使用内置工具）。
再往后是两段**诊断**（都只是解释，门禁照旧只看 `grandTotal`；数据缺失时写 Skipped，
不填零）：

| 章节 | 在回答什么 |
|---|---|
| Bucket detail | 逐任务 input / output / cache read 的 base→ops 差异与 Δ%（每任务一行，另附 TOTAL） |
| **Token buckets (TOTAL)** | 三个桶各自的 base→ops 与 Δ（含 Δ%）：同样的 Δ 落在 cache read 还是 uncached input，计价差一个数量级 |

usage 不完整时这两张表打印 Skipped，不把下界当测量；`results/*.events.ndjson` 里每一步的
`step_end.usage` 都还在，用当前 harness 重跑或重新聚合即可恢复。

自检（不 spawn dsh、不花 token）：`node bench/run.mjs --dry-run --label selfcheck --profile selfcheck`，
它只把 fixture 生成与 verify 两头各跑一遍，验证语料的形状还成立。

### 4.2 任务语料：六个任务各测什么

模型进门只看到一句英文 prompt 和一个由 fixture 现场生成的临时 workspace；下表是
`bench/tasks/*.task.json` 的现状（规格与打点意图见 PLAN §7，期望值全部由生成字节推导，模型看不到）。
前四题（csv-sum … noisy-test-triage）是复盘中挑出的**贴近日常**的场景，刻意不挑边；
`api-rename` 收窄成"只用文件工具"的 capability probe，测的是同一类形状下的工具选择；
最后一道 `gate-repair-loop` 是 **长跑档**（见 §4.3），workspace 很小而**步数**很多，
专门用来回答"每步的节省在几十步的尺度上还成不成立"：

| 任务 | workspace 里有什么 | 模型要干什么 | 考什么 | 怎么判卷 |
|---|---|---|---|---|
| **csv-sum** | 8000 行 `data.csv`（`id,region,amount`，约 112KB） | 算出 `region=EU` 的 `amount` 总和，把纯整数写进 `answer.txt` | 是整读进上下文再心算，还是一条聚合命令就地求和（标题里的 "without drowning the context"） | `fileEquals`：与生成器边写边累加出的精确值比对 |
| **config-hunt** | 三层配置 JSON + 12 个包（每个包带一个**不参与合并**的 `config.json` 诱饵）+ 写明合并顺序的 `README.md`，四个文件的同一个 key 值互不相同 | 按 README 的顺序求出 production 下 `MAX_UPLOAD_MB` 的生效值，只把这个整数写进 `answer.txt` | "grep 到第一个数就交差"vs 读约定再求值；多文件探索的步数 × 每请求固定开销 | `fileEquals`：与最高优先级那一层的值比对 |
| **big-file-paging** | 单个 `src/pipeline.js`，约 4200 行 / 170KB；`LIMIT_TABLE` 在 ~55% 处，`auditLimit()` 在最后 12 行读它；另有历史注释与 `LEGACY_LIMIT_TABLE` 两个错值 | 写出 `auditLimit('staging')` 的返回值，只把这一个整数写进 `answer.txt` | 整读 4 千行 vs 定位到两段远处区间各读一次：日常最高频的"在长文件里找答案" | `fileEquals`：与活表里的值比对（两个诱饵值都不同） |
| **noisy-test-triage** | `runner.js` 打印 2400 行 `ok N - …`（每 250 行一条 `# progress`），恰好一行 `not ok N - …` 带断言诊断，退出码 1 | 跑 `node runner.js`，把失败用例名（`not ok <number> - ` 之后的原文）写进 `failure.txt` | 大输出的裁剪与定位：`\| grep`/有界搜索 vs 把 6 万字符日志灌进上下文 | `fileEquals` + 把"套件确实在挂"钉成 `invariant` 的 `command` 检查（前提破了 dry-run 拒绝这题） |
| **api-rename** | `src/core.js` 有 `parsePayload` 与两个长相符号（`…Legacy`、`…Async`，后者**调用**目标函数）；60 个模块中 1/5 只用到长相符号；根目录 `check.mjs` import 改后的名字 | 把 `parsePayload` 改名为 `decodePayload`（定义/import/调用点），长相符号保持原名，**只用文件工具改**（禁止 shell 文本替换），不改行为、不增删 `src/` 文件，完成后 `node check.mjs` exit 0 | 跨文件批量替换 vs 逐文件 read+edit；字面量替换的边界（前缀相同的符号、长相符号体内的调用点） | `contentHashes` 逐文件字节比对（漏改一处或顺手改错都挂）+ `command node check.mjs` exit 0 |
| **gate-repair-loop** | `gates/gate_00.js`–`gate_23.js` 共 24 个阶段模块（各 70 行惰性填充，把契约和代码隔开），加一个 **fail-fast** 的 `check.js`；每个阶段只有一个绑定常量与自己的契约注释不符 | 跑 `node check.js`（它逐阶段比对 golden 值、在第一个不符处停下），修 `gates/` 里失败的阶段直到 exit 0，再把门禁打印的最终值写进 `answer.txt` | **长跑形状**：24 个阶段 ⇒ 至少 24 轮"跑→读→改"，且第 N 轮要把前 N 个阶段累积的通过行重新带进上下文（末轮约 22KB）——考的是**步数**与每步的固定开销，不是单次上下文体积 | `command node check.js` exit 0 + `fileEquals answer.txt`；`check.js` 另挂 `fileEquals` 的 `invariant` 守卫防篡改 |

规模本身就是被测信号：token、步数、工具调用数都进 metrics。csv-sum / config-hunt /
big-file-paging / noisy-test-triage 是**不挑边**的日常形状，api-rename 则被收窄成
"只用文件工具"的 probe，谁赢都能读出来；最后一题反过来只放大**步数**（同一套工具面
要付几十次，见 §4.3）。

api-rename 的"只用文件工具"是**提示词约定，不是判卷条件**：`verify` 只读最终状态，
一次 `sed` 照样通过（`contentHashes` 分不出用了什么过程）。它测的是模型用不用文件工具——
报告里的 `tool calls` / `steps` 与每步重发的上下文——而不是约束本身；要门禁化只能引入
带审计的 helper（判卷看审计），代价是任务从"日常形状"变成"按协议做题"。

`repeat` 现在每道题缺省都是 2 次/侧（合计 12 次/侧）；语料变重时仍可用 `repeat` 字段分层，
显式 `--repeat N` 会覆盖整个预算。

`ops_replace` 每改一个文件会在同目录留下一个 `.dsh-ops-update-<sha256>.lock`。它**不是残留**：
发布是原子改名，锁必须活在目标 inode 之外，所以插件按文件名哈希建一份持久协作锁、从不删除
（`docs/windows-verification.md` W1h）。它是工具状态而不是工作区内容，判卷因此跳过这一种
文件名——`contentHashes` 只对这一种形状放行，其余多余文件照旧判失败，提示词里"不增删文件"
那条约定也照旧由它守着。注意 `ops_glob` / `ops_grep` 本来就不报它（隐藏组件规则），
所以模型在 workspace 里看不见这些文件。

### 4.3 长跑档（`gate-repair-loop`）

这一题量的是反过来的东西：workspace 只有约 90KB，但
`check.js` 是 **fail-fast** 的——它按顺序校验 `gates/` 里的阶段、在第一个不一致的阶段退出，
所以修好一个阶段只换来一个阶段的进展，24 个阶段至少要 24 次运行；而第 N 轮会把前
N 个阶段累积的通过行重新带进历史（末轮约 22KB）。

为什么值得单列一档：这一题放大的是**步数**。每轮都要把前面阶段的通过行重新带进历史，
固定开销按 step 线性累加；短跑里这笔钱可能被"少跑两步"抵消掉（test10：固定开销 +16,065，
多跑的步数 −12,450），长跑里步数差没有地方藏。所以它回答的是：每步的节省在几十步的尺度上
还成立吗，还是被步数和上下文增长吃掉——**先看主表的 steps 列与 TOTAL，再看
`## Token buckets` 的 Δ 构成**，别只看总量。

配平旋钮都在 `fixture.params` 里：`gates` 决定最少轮数（也决定步数下限），`probes`
决定每轮日志的行数（也就决定每步要重新带多少工具输出），`linesPerGate` 决定每个阶段
模块读起来有多大。改这三个数就换了口径，**改完两侧都要重跑**。

```console
node bench/run.mjs --label bench-base --profile bench-base --folder long-run --task gate-repair-loop
node bench/run.mjs --label bench-ops  --profile bench-ops  --folder long-run --task gate-repair-loop
node bench/compare.mjs bench-base bench-ops --folder long-run --fail-on both
```

### 门禁与退出码

- `regression`：缺省逐任务判定（`--regression-scope task`）——任一任务候选 median token
  > 该任务基线 × (1 + tolerance) → 退出码 1（失败原因打印在命令行；Markdown 报告不再带
  门禁行）。旧的 TOTAL 之和判定可用 `--regression-scope total` 取回，`both` 两个都判；
- `pass-drop`：任一任务或 TOTAL 的通过率下降 → 退出码 1（token 降了但任务做不对 = 无效优化）；
- 任一侧 usage 不完整 → token 列打印 `n/a`，`regression` 自动降级为仅 `pass-drop`；
- 两侧 model/provider 不一致等公平性问题 → 记入比较结构的 `warnings`（`--json` 可见；
  Markdown 报告不再单列 Warnings 段）。

`run.mjs`：`0` 表示整轮跑完并落盘（任务失败是被测量的结果，不是运行器的错误）、
`1` 表示 preflight 或运行器故障、`2` 表示命令行用法错误。
`compare.mjs`：`0` 门禁通过、`1` 门禁失败、`2` 输入或命令行用法错误。

## 5. 产物结构

```text
bench/runs/<组目录>/<UTC时间戳>-<label>/     组目录缺省是本地当天日期，如 2026-10-16/
  meta.json            label、folder（实际归档的组目录，含缺省的当天日期）、profile、dsh 入口与版本、平台、双 node 版本、overlay、preflight 警告、narration 段
  runner.log           全程现场日志（追加写）：preflight、spawn、里程碑、心跳、静默警告、结局
  dump-config.txt      带 --patch 的组合树存档（公平性证据）
  summary.json         机器可读汇总（compare.mjs 的输入）
  report.md            单 run 简报
  results/
    <taskId>-r<n>.metrics.json     单次运行指标（usage 四桶、步数、工具调用、verify 明细、liveNarration 计数）
    <taskId>-r<n>.events.ndjson    原始事件流存档
    <taskId>-r<n>.stderr.log       dsh 的 stderr
```

对比报告 `comparison-<base>-vs-<cand>.md` 落在**候选 run 的上一层**：用 `--folder` 时是
`bench/runs/<folder>/`，平铺布局时是 `bench/runs/`。run 目录本身是一次归档（`summary.json`、
`results/`、`runner.log`），对比是两侧归档之间的关系，不该写进归档里；同一分组内同一对 label
重跑对比只会更新同一份报告。`bench/runs/` 与 `bench/llm.patch.yml` 都在 `.gitignore` 里。

## 6. 会话目录清理

每个 headless run 都会在 `$DSH_HOME/sessions/<工作区slug>/` 留下持久化会话；harness 不自动删
（不碰用户数据）。清理办法：按 mtime 删除 `~/.dsh/sessions/` 下对应 `dsh-ops-bench-*` 工作区
slug 的目录。彻底免疫的方式是隔离 home：`--dsh-home D:\bench\dsh-home`，此时 profiles 与
sessions 全在 benchmark 目录里，**清理 = 删目录**（代价：插件要往隔离 home 里重装一次）。

```console
:: 隔离模式：对隔离 home 重跑第 2 节的步骤 1-2，之后所有命令都带 --dsh-home
set DSH_HOME=D:\bench\dsh-home
node bench\run.mjs --label bench-base --profile bench-base --dsh-home D:\bench\dsh-home
```

隔离模式还能避开另一个坑：`$DSH_HOME/cordis.patch.yml`（home 层 patch）会被组合进**每一个**
profile 且优先于 profile 层。跑分的人若在这里放过自己的模型路由或额外插件，`bench-base`
就不再 stock，整个对比作废 —— preflight 会在该文件存在且非空时显著警告，`--strict` 直接拒绝。

## 7. 新增一个任务

在 `bench/tasks/` 放一个 `<id>.task.json`（格式见 PLAN §4.1）：

```json
{
  "id": "my-task",
  "title": "What this measures",
  "prompt": "English, exact, machine-verifiable. Must NOT start with '-' (the headless launcher would read it as an option).",
  "fixture": { "generator": "largeCsv", "params": { "seed": 7, "rows": 2000 } },
  "verify": [{ "type": "fileEquals", "path": "answer.txt", "expect": "sum" }],
  "timeoutMs": 900000
}
```

- `fixture.generator` 必须是 `bench/lib/fixtures.mjs` 导出的生成器名（`grepTree`、
  `renameTree`、`largeCsv`、`brokenProject`、`logStats`、`configTree`、`deepModule`、
  `deepCorpus`、`noisySuite`、`symbolTree`、`gatePipeline`）；新加生成器请用 seeded PRNG，
  同 seed 逐字节可复现，并把期望值放进 `exports`。
- `verify` 检查类型：`fileExists` / `fileMissing` / `fileEquals` / `fileContains` /
  `fileLines` / `countFiles` / `contentHashes` / `command`（PLAN §4.3）。`expect` 引用生成器导出的键名，
  `text` / `lines` / `count` 是字面量。`invariant: true` 标记"防篡改守卫"：它允许在
  未开工的工作区上通过（`--dry-run` 的判定会豁免它）。
- 一切写操作必须留在会话工作目录内：headless 没有应答器，需要审批的操作 fail closed。
- 加完之后跑 `node bench/run.mjs --dry-run --label x --profile x`，它会确认每个答案检查
  在未开工的工作区上**确实失败**（否则这个任务什么都没验证）；再跑 `node test/run.mjs bench`。

## 8. 方法论与免责声明

1. **公平性锚**：两侧同 provider、同 model、同上下文配置，由共用同一份 `--patch` overlay
   保证；每个 run 目录存档带 overlay 的 `dump-config.txt`。
2. **方差**：模型输出非确定。采样按语料的分层预算（每任务 `repeat` 字段，2 次，显式
   `--repeat N` 统一覆盖），取中位数；单次差异在噪声内没有意义。
3. **口径**：`grandTotal` = input + output + cacheRead + cacheWrite 四桶之和；
   `reasoningTokens` 单列展示、**不**计入总量。cache 桶是否"省钱"取决于计价模型，
   所以报告在 `## Token buckets` 里分桶展示 base→ops 与 Δ——同样一个 +54% 的 Δ，
   落在 cache read 和落在 uncached input 上不是同一张账单，报告不替读者把这两个数合并掉。
4. **Δ 的归因是一阶分解，不是因果证明**：`compareSummaries` 仍把 Δ 拆成固定开销 / 多跑的
   步数 / 残差（工具结果更大、上下文涨得更快），三项相加等于 prompt 的 Δ，加上 Δ output
   等于总 Δ——这是算术恒等，不是结论：残差里既有"某个工具吐了一大坨"，也有"模型这次
   多验证了一遍"，要分清得翻 `results/*.events.ndjson`。这项分解保留在比较结构与
   `--json` 输出里，Markdown 报告不再展开；门禁只判 `grandTotal`。
5. **观测性指标**：`textChars` / `thinkingChars` 受事件流 32KB 单行截断影响，只作观察，
   不进门禁。
6. **自测声明**：结果只描述"这台机器、这个模型、这组任务、这个时间"的测量，不构成可外推的
   官方节省百分比（对齐 [PROVENANCE.md](../PROVENANCE.md)：*No benchmark is inferred*）。
7. **shell 引擎是测量条件之一**：基线 = Windows PowerShell 5.1（必须按 §2.1 钉住，否则它会命中
   PATH 上的 Store pwsh 7，两侧就都是 7），候选 = 插件自带的 pwsh 7。`meta.json` 不记录引擎，
   `compare.mjs` 的公平性锚也只覆盖 provider/model —— 所以跑完要用 §3 的冒烟，或翻 run 目录里的
   `dump-config.txt` 确认基线那行 `pwshPath`，并在写结论时说清是哪两个引擎在比。
8. 本 harness 与 `scripts/measure-schemas.mjs`（静态 schema 字节）互补，不替代它：前者量的是
   模型**用**了这些 schema 之后的实际消耗，后者量的是 schema 本身的字节数。
