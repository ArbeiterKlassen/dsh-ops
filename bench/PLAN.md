# dsh-ops 端到端 Token Benchmark —— 设计与实施计划

> 状态：**已实现**（`bench/run.mjs`、`bench/compare.mjs`、`bench/lib/*`、`bench/tasks/*.task.json`、
> `bench/README.md`、`test/bench.test.mjs`）。实现与实测在 Windows x64 机器上进行；
> 落地时对设计做的四处必要修订记录在 §13，以 §13 为准。
> 主对比场景：**无插件基线（stock dsh-base 工具面） vs 装有 dsh-ops 的候选**。
> 同一套 harness 也支持"旧版 dsh-ops vs 新版 dsh-ops"（换 profile 里安装的插件版本即可）。
>
> 本文档自包含：第 2 节记录了在 macOS 上对 DSH `0.2.0-rc.2` 实地调研得到的全部接口事实，
> 并已在 Windows x64 上对本机安装的 `0.2.0-rc.2` 源码逐条复核，实现时不需要重新逆向。
>
> 本次修订吸收 Windows 侧评审结论：dsh 的 spawn 方式（§2.7、§5.1）、LLM endpoint 改用
> `--patch` overlay 注入（§2.7、§8）、home 层 patch 污染防护（§2.7、§5.1）、pnpm 前置（§2.3、§8）、
> profile 初始化语义确证（§2.3）、errorEvents 与双 node 版本记录（§4.4、§4.5）。

---

## 1. 目标与非目标

**目标**：回答"某个修改（prompt 段、工具描述、schema、工具行为、插件整体）之后，
真实模型跑真实任务，token 消耗降了没有？降了多少？任务还能不能完成？"

- 端到端测量：以 provider 上报的 usage 为准（与 TUI `/tokens` 同源），不是静态字节估算。
- 可重复：任务语料确定性生成、每 run 全新会话与全新工作区、重复 N 次取中位数。
- 可审计：原始 NDJSON 事件流全部落盘存档。
- 有门禁：候选 token 回归或任务通过率下降 → 对比命令非零退出。

**非目标**：

- 不替代 `scripts/measure-schemas.mjs`（静态 schema 字节测量保留，二者互补）。
- 不产出可对外引用的"官方节省百分比"——报告永远标注自测口径（对齐 `PROVENANCE.md`：
  "No benchmark is inferred"，不得做无实据声明）。
- 不测 TUI/Web 交互层；只测 headless 单发会话。

## 2. 调研结论（DSH 0.2.0-rc.2 接口事实）

实现所依赖的全部机制已在 macOS 上核实，并在 Windows x64 上对本机安装的 `0.2.0-rc.2`
源码（npm 全局 `@deepseek-ai/dsh/node_modules/@deepseek-ai/...`）逐条复核。与最初调研
结论不同的两处，以本文档为准：§2.3 初始化语义已确证（销掉兜底分支）、新增 §2.7
launcher 分层与 Windows spawn 事实。

### 2.1 headless 单发模式

- 调用：`dsh --profile headless --json "<task>"`
  （源码：`dsh-headless/lib/startup.js`，commander 定义 `[task...]` 位置参数 +
  `--json` + `--session-id`；多词 task 用空格拼接；`-` 读 stdin 且必须是唯一参数）。
  harness 侧两条硬约束：**Windows 上不能直接 spawn `dsh`，必须解析 JS 入口后用
  `process.execPath` 启动（§2.7）**；`<task>` 作为单个 argv 元素传入且**不得以 `-`
  开头**（会被 commander 当选项解析）——写进 tasks.mjs 的结构校验。
- 行为（`dsh-headless/lib/index.js`）：新建一个 Agent（或按 `--session-id` 收养既有会话，
  benchmark 不用收养），投递任务，跑到 quiescence，flush 会话，
  **退出码 0 当且仅当 `turn/end.reason.kind === "completed"`**，否则 1；
  `--json` 时 stdout 输出 NDJSON 事件流，stderr 输出诊断。
- headless profile = `dsh-base` + `dsh-headless` 两个 bundle，无 Host/HTTP/浏览器层
  （`dsh-app-boot/lib/index.js` 的 `PROFILE_TEMPLATES`）。
- headless **不组合 agent preset**（收养带 preset 的会话会直接报错；新建会话无 preset）。

### 2.2 `--json` NDJSON 事件格式（`dsh-headless/lib/json-stream-*.js`）

每行一个 JSON 对象，字符串按 8KB、整行按 32KB 截断（截断时带 `"truncated":true`；
`final` 事件不截断）。事件类型：

| 事件 | 形状 | 说明 |
| --- | --- | --- |
| `session` | `{type,sessionId,cwd}` | 流首事件 |
| `status/turn_start` | `{type:"status",phase:"turn_start",turn}` | |
| `status/step_start` | `{type:"status",phase:"step_start",turn,step}` | |
| `thinking` | `{type:"thinking",text}` | 提交后的 reasoning 块 |
| `text` | `{type:"text",text}` | 提交后的正文块 |
| `tool_call` | `{type:"tool_call",callId,tool,input}` | `input` 为解析后的对象；解析失败保留原始字符串 |
| `tool_result` | `{type:"tool_result",callId,status:"completed"\|"error",result}` | `result` 是模型可见文本块的拼接 |
| `status/step_end` | `{type:"status",phase:"step_end",turn,step,usage?}` | **usage 见下** |
| `status/turn_end` | `{type:"status",phase:"turn_end",turn,reason}` | `reason.kind` 为 `completed`/`error` 等 |
| `final` | `{type:"final",text}` | 最终回答全文（不截断） |
| `error` | `{type:"error",message}` | 启动/运行失败 |

**usage 字段**（`step_end`，provider 上报、DSH 归一化）：

```json
{ "inputTokens": 0, "outputTokens": 0,
  "totalTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": 0 }
```

- 四桶互斥模型：`input`（未缓存输入）/`output`/`cacheRead`/`cacheWrite`；
  `totalTokens`、`reasoningTokens` 为可选（provider 报了才有）。
- 一个 step 的 usage 是其全部 attempt（含被重试丢弃的）的累加；
  **任何一个 attempt 没报 usage，整个 step 的 usage 字段直接省略**（宁缺毋假）。
  → 聚合器必须统计 `stepsWithUsage/steps`，缺失时明确报"usage 不完整"，绝不拿部分和冒充完整。

### 2.3 profile / 模型路由 / 插件

- 自定义 profile：`dsh <name> --from-default-profile headless` 从 headless 模板创建并启动；
  配合 `--dump-config`（打印组合树后退出）可**只初始化不跑任务**：
  `dsh bench-base --from-default-profile headless --dump-config >NUL`。
  **已确证**（Windows 源码：`dsh/lib/dump-config-*.js` → `prepareProfile` →
  `initializeProfileFromDefault` → `initProfile` 写盘，全程不 boot 插件、不跑任务），
  原"实测确认 / smoke 兜底"步骤销案。两个推论：对**已存在**的 profile 重跑
  `--from-default-profile` 会直接 throw（target directory exists）→ setup 必须幂等
  （先探测 profile 目录，存在即跳过）；shipped 模板名（headless/web/acp/sdk/sdk-minimal）
  不能作为自定义 profile 名。
- 模型路由可以写 profile 的 patch 层 `~/.dsh/profiles/<name>/cordis.patch.yml`，
  也可以放独立 patch 文件由 launcher 的 `--patch <file>` 在每次调用时注入（§2.7）——
  **本 benchmark 采用后者**（`bench/llm.patch.yml`，两 profile 共用一份，公平性由构造
  保证；见 §5/§8）：
  - `llm-pi-ai` 行 `config.providers.<路由名>`：`{baseURL, apiKeyEnv, api:"openai-completions", models:[{id, contextWindow?, maxTokens?, reasoningEfforts?}], retryPolicy?}`
    （dsh-base 默认挂载 `llm-pi-ai`，零路由休眠，配置即注册）。
  - `agent-default-model` 行 `config:{provider, model}`（两项均 required；
    headless 用 `agentDefaultModel.currentSelection()` 决定路由）。
  - API key：`apiKeyEnv` 指定的环境变量名，凭据可放环境或 `$DSH_HOME/.credentials.yaml`
    （POSIX 上该文件有 owner-only 权限硬检查，mode 非 600 时 dsh 拒绝启动）。patch 文件
    只写变量名，**密钥不进任何仓库文件**。
- 插件安装走官方 profile 管理器：`dsh plugin --profile <name> add <spec>`
  （pnpm 参数透传：版本号 / 本地路径 / tarball 均可；dsh-ops 自己的 installer
  `lib/profile-install.js` 就是 `dsh plugin --profile <t> add dsh-ops@<version>`）。
  卸载：`dsh plugin --profile <name> remove dsh-ops`。
  **pnpm 是硬前置**：`dsh plugin` 找不到 pnpm 时报 exit 127（"install pnpm and
  make it available on PATH"），写进 §8 前置检查。本地目录路径是 pnpm `file:` 语义
  （安装时快照拷贝，checkout 后续改动不生效，改了要重装）；`optionalDependencies`
  （`@dsh-ops/*-win32-x64` 原生包）需要 registry 解析 → 可复现性优先 published 版本
  或 `npm pack` tarball，离线环境需预备缓存。
- dsh-ops 的 `package.json` 声明 `os:["win32"], cpu:["x64"]`，且 payload 只有
  win32 包 → **插件 variant 只能在 Windows x64 上装/跑**；harness 代码本身跨平台。

### 2.4 权限与沙箱（任务设计的硬约束）

- headless 无交互应答器：需要审批的操作 **fail closed**（直接拒绝）。
- 默认沙箱 workspace-write：任务的一切写操作必须留在会话工作目录内 → fixture、
  产出文件、`node test.js` 全部在工作区内，天然满足。
- 不要在任务里设计需要 network / 越权写的步骤。

### 2.5 会话持久化副作用

每个 headless run 会在 `$DSH_HOME/sessions/<工作区slug>/<sessionId>/session.v4.jsonl.zstd`
留下持久化会话。benchmark 用临时工作区 → 会积累一次性会话目录。README 要给出清理提示
（按 mtime 删除 `~/.dsh/sessions/` 下对应临时工作区 slug 的目录），harness 不自动删。

**隔离选项**：`resolveDshHome` 尊重 `$DSH_HOME` 环境变量（优先于 `~/.dsh`，
`test/run.mjs` 已用此机制隔离）。run.mjs 提供 `--dsh-home <dir>` 把 profiles/sessions
全部指进 benchmark 自有目录：会话累积与 home 层污染（§2.7）同时消失，清理 = 删目录；
代价是插件要往隔离 home 里装一次（§8 进阶模式）。

### 2.6 自托管服务器的 usage 上报前提（实测第一关）

`step_end.usage` 依赖 provider 在**流式响应**里回报 usage。OpenAI 兼容服务器需要支持
`stream_options: {"include_usage": true}`（vLLM / sglang / llama.cpp 各有开关或版本要求）。
若服务器不报：事件流里 `step_end` 无 usage → harness 仍能数步数/工具调用，但**拒绝给出
token 结论**。实施步骤里必须先跑 smoke 任务确认 usage 存在，再开始正式测量。

### 2.7 launcher CLI 分层与 `--patch` overlay（Windows 复核新增）

源码：`@deepseek-ai/dsh/lib/bin.js`、`lib/profile-boot-*.js`、`lib/dump-config-*.js`、
`lib/plugin-*.js`，均已在本机 Windows 安装包上核实。

- **patch 层顺序**：bundle → profile（`profiles/<name>/cordis.patch.yml`）→ home
  （`$DSH_HOME/cordis.patch.yml`）→ CLI（`--patch <path>`，可重复）。CLI 层最后应用；
  id-targeted patch **整段替换 config**（不深合并）。`--dump-config` 会连同全部四层
  渲染（含 argv overlay），`--dump-default-config` 只渲染 bundle 层。
- **`--patch <path>` 在 boot 与 dump-config 都生效**（`runProfile`→`composeProfile(patchFiles)`
  与 `runDumpConfig` 均确认传入）→ 本 benchmark 用它注入 LLM 路由，不再手工编辑任何
  profile 的 cordis.patch.yml；base/cand 共用同一份 overlay 文件，provider/model 一致性
  由构造保证而非文档提醒。
- **patch 目标安全性**：`llm-pi-ai` 的 Config 只有 `providers` 一个字段，
  `agent-default-model` 只有 `provider`/`model`（reasoning 可选）→"整段替换 config"
  不会误伤其他字段。patch 的 id 在组合树中不存在时**警告并跳过（不报错）** →
  preflight 必须用 `--dump-config` 输出确认两个补丁真实生效（§5.1）。
- **home 层污染风险**：`$DSH_HOME/cordis.patch.yml` 会被组合进**每一个** profile 且
  优先于 profile 层。跑分的人若在这里放过自己的模型路由或额外插件，bench-base 就不再
  stock，整个对比作废 → run.mjs preflight 检查该文件存在且非空时显著警告（`--strict`
  直接拒绝）；彻底隔离用 `--dsh-home`（§2.5）。
- **Windows spawn 事实（硬伤，已改设计）**：npm 全局安装在 PATH 上的 `dsh` 是三个
  shim——`dsh`（bash 脚本）、`dsh.cmd`、`dsh.ps1`，真身入口是
  `<npm-prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`（package.json 的 `bin.dsh`）。
  Node 无 shell spawn 不可行：无扩展名 bash 脚本 CreateProcess 执行不了；`.cmd`/`.bat`
  自 CVE-2024-27980 修复后无 `shell:true` 直接抛 `EINVAL`；而 `shell:true` 会让 cmd.exe
  二次解释 prompt 里的引号/空格，破坏确定性。
  → **run.mjs 一律 `spawn(process.execPath, [binJs, ...args])`**（无 shell、参数数组
  安全、跨平台同构）；binJs 自动发现算法见 §5.1，`--dsh` 保留为覆盖入口。
- **调用参数顺序**：launcher 自有选项在前，透传给 app 的选项次之，task 位置参数最后：
  `node <binJs> --profile <p> --patch <llm.yml> --json "<task>"`
  （透传语义见 bin.js 帮助示例 `dsh --profile tui --resume abc`）。
- **pnpm 前置**：见 §2.3，exit 127 提示原文 "pnpm was not found; install pnpm
  and make it available on PATH"。

## 3. 架构与目录

```
bench/
  PLAN.md              # 本文档
  README.md            # 方法论 + Windows 环境搭建 + 免责声明（实现时写）
  run.mjs              # 运行器 CLI
  compare.mjs          # 对比 CLI（报告 + 门禁）
  llm.patch.example.yml # LLM 路由模板（提交进仓库）；复制为 llm.patch.yml 填写（gitignore）
  lib/
    tasks.mjs          # 任务语料加载与结构校验
    fixtures.mjs       # 确定性工作区生成器（seeded PRNG）+ 期望值导出
    verify.mjs         # 完成度机器校验（无 shell、跨平台）
    aggregate.mjs      # NDJSON 事件流 → 单次运行指标（纯函数，可单测）
    compare-core.mjs   # 两份 summary → 对比结构（纯函数，可单测）
  tasks/
    grep-sweep.task.json
    bulk-rename.task.json
    csv-sum.task.json
    fix-build.task.json
    log-stats.task.json
  runs/                # 运行输出，gitignore
    <UTC时间戳>-<label>/
      meta.json            # label、profile、resolved dsh 入口+版本、平台、双 node 版本、overlay 路径、尽力提取的 provider/model
      dump-config.txt      # dsh --profile <p> --patch <llm.yml> --dump-config 存档（公平性证据，含 overlay 层）
      summary.json         # 机器可读汇总（compare 的输入）
      report.md            # 单 run 简报（人读）
      results/
        <taskId>-r<n>.metrics.json
        <taskId>-r<n>.events.ndjson   # 原始事件存档
        <taskId>-r<n>.stderr.log
```

代码风格对齐仓库现状：ESM、零外部依赖、无分号、单引号、2 空格缩进、JSDoc 模块头。
Node 版本按 `engines`：`^22.19 || >=24`。

## 4. 数据格式

### 4.1 任务语料（`bench/tasks/*.task.json`）

```json
{
  "id": "csv-sum",
  "title": "Aggregate a large CSV without drowning the context",
  "prompt": "The file data.csv has the header id,region,amount. Compute the sum of the amount column over all rows whose region is exactly EU. Write only the resulting integer into answer.txt (no other characters).",
  "fixture": { "generator": "largeCsv", "params": { "seed": 7, "rows": 20000, "targetRegion": "EU" } },
  "verify": [ { "type": "fileEquals", "path": "answer.txt", "expect": "sum" } ],
  "timeoutMs": 900000
}
```

- `prompt` 用英文（省 token、避免 CJK 分词差异引入噪声），描述必须**精确且机器可校验**。
- `fixture.generator` ∈ fixtures.mjs 导出的生成器名；`params` 原样传入。
- `verify[].expect` 引用生成器导出的期望值键名；也可用字面量 `text`/`lines`/`count`。
- `timeoutMs` 缺省 900000（15 分钟）。

### 4.2 fixture 生成器契约（`bench/lib/fixtures.mjs`）

每个生成器 `(params) => { files, exports }`：

- `files`: `[{ path, content }]`，path 为 POSIX 相对路径，由 run.mjs 写入工作区；
- `exports`: 期望值字典（数字/字符串/字符串数组），供 verify 引用；
- **确定性**：内部用 mulberry32 seeded PRNG，同 seed 两次生成逐字节一致（单测覆盖）；
- 生成物不提交进 git（每次 run 现场生成，体积小、速度快）。

### 4.3 verify 检查类型（`bench/lib/verify.mjs`）

全部只用 `node:fs` + `node:child_process.spawn`（不经 shell，跨平台）：

| type | 参数 | 判定 |
| --- | --- | --- |
| `fileExists` | `path` | 存在 |
| `fileMissing` | `path` | 不存在 |
| `fileEquals` | `path`, `text`\|`expect` | 内容 trim 后全等 |
| `fileContains` | `path`, `text`\|`expect` | 包含子串 |
| `fileLines` | `path`, `lines`\|`expect` | trim 后非空行序列全等（有序） |
| `countFiles` | `dir`, `prefix?`, `suffix?`, `extension?`, `count`\|`expect` | 递归计数全等 |
| `contentHashes` | `dir`, `expect` | 目录内文件与 `[{name, sha256}]` 清单逐字节全等（缺失/改内容/多余文件都算失败）——证明"只改名，没动内容"。唯一放行的是工具自己的协作锁 `.dsh-ops-update-<64 hex>.lock`（工具状态而非工作区内容，见 bench/README §4.2） |
| `command` | `command`, `args?`, `exitCode?=0`, `cwd?="."` | spawn 退出码全等；`command:"node"` 映射 `process.execPath` 保证确定性 |

单个检查失败不中断，全部跑完；结果 `{passed, checks:[{type,path?,passed,detail}]}`。
`detail` 只放短摘要（期望 vs 实际的前 200 字符），防止把大内容灌进报告。

### 4.4 单次运行指标（`<task>-r<n>.metrics.json`）

```json
{
  "format": "dsh-ops-bench-metrics-v1",
  "label": "cand-0.3.1", "profile": "bench-ops",
  "taskId": "csv-sum", "repeatIndex": 0,
  "startedAt": "ISO", "durationMs": 0,
  "exitCode": 0, "timedOut": false,
  "sessionId": "session-...", "turnEndReason": "completed",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
             "cacheWriteTokens": 0, "reasoningTokens": 0, "grandTotal": 0 },
  "usageReported": true, "steps": 0, "stepsWithUsage": 0, "turns": 0,
  "prompt": { "reported": true, "firstStep": 0, "median": 0, "max": 0, "total": 0,
              "perTurn": [{ "turn": 1, "tokens": 0 }] },
  "toolCalls": 0, "toolErrors": 0, "toolCallsByName": {},
  "textChars": 0, "thinkingChars": 0, "finalTextBytes": 0,
  "eventCount": 0, "malformedLines": 0, "errorEvents": [],
  "verify": { "passed": false, "checks": [] },
  "eventsFile": "results/csv-sum-r0.events.ndjson"
}
```

- `grandTotal` = 四桶之和（input+output+cacheRead+cacheWrite）；
  `reasoningTokens` 单列展示，**不**计入 grandTotal（通常是 output 的子集）。
- `prompt` = 每一步的**输入侧**规模（input+cacheRead+cacheWrite，即模型每轮被重发的
  上下文；provider 只报 `totalTokens` 时用它减去 output 兜底）：
  - `firstStep` = **本 run 第一步**的 prompt。它没有历史，等于系统提示 + 工具 schema +
    任务文本，所以两侧相减就是工具面/提示词策略的**每次请求固定开销**；该步若丢了 usage，
    这里写 `null` 而不是把第二步（已 warm、更小）顶上来。
  - `median`/`max`/`total` = 各步 prompt 的中位/最大/总和（`total` 与 usage 的
    input+cacheRead+cacheWrite 一致）。
  - `perTurn` = 每个 turn 第一步的 prompt，多轮任务用它区分"问得少"和"带得少"。
  - 老归档没有这个字段：compare 侧渲染为 Skipped，不当作 0。
- `usageReported` = `steps > 0 && stepsWithUsage === steps`；false 时 usage 各字段仍写
  已知部分和，但 compare 拒绝据此下 token 结论。
- 可选桶（provider 没报的）按 0 计并在 `usage` 里省略对应键，聚合器记录哪些桶出现过。
- `errorEvents` 收集流里的 `{type:"error"}` 事件（message 截断 200 字符）：headless
  启动失败（profile 坏、patch 语法错、凭据缺失）就长这样，不进 metrics 会很难排障。
- `textChars`/`thinkingChars` 受 2.2 的 32KB 单行截断影响（usage 不受影响），只作
  观察性软指标，**不进门禁**；报告脚注声明。

### 4.5 `summary.json`

```json
{
  "format": "dsh-ops-bench-summary-v1",
  "label": "...", "profile": "...",
  "dshEntry": "<npm-prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "dshVersion": "0.2.0-rc.2", "llmPatch": "bench/llm.patch.yml",
  "model": { "provider": "...", "model": "...", "bestEffort": true },
  "platform": { "os": "win32", "arch": "x64", "node": "v24.x", "pathNode": "v24.x" },
  "startedAt": "ISO", "finishedAt": "ISO", "repeat": 3,
  "taskRepeats": { "csv-sum": 2, "bulk-rename": 3, "fix-build": 4, "grep-sweep": 2, "log-stats": 5,
                   "config-hunt": 2, "big-file-paging": 2, "noisy-test-triage": 2, "api-rename": 2,
                   "long-corpus-ledger": 2, "deep-module-256k": 2, "gate-repair-loop": 2 },
  "taskIds": ["..."], "results": [ "<4.4 的 metrics 数组>" ],
  "totals": { "grandTotal": 0, "steps": 0, "toolCalls": 0, "toolErrors": 0,
              "passed": 0, "failed": 0, "usageComplete": true }
}
```

`model` 来自对 `dump-config.txt` 的尽力正则提取（找 `agent-default-model` 段的
`provider:`/`model:`），提不到就 null + bestEffort 标记，不阻塞运行。
`platform.node` = 跑 run.mjs 的 `process.execPath` 版本（verify 的 `command:"node"`
用它）；`platform.pathNode` = PATH 上 `node` 的版本（任务内模型自跑 `node test.js`
用它）。两者可能不同，都记录；README 要求 PATH 的 node 同样满足 `engines`（§10 第 6 条）。

## 5. run.mjs 设计

```
node bench/run.mjs --label <label> --profile <dsh-profile>
                   [--task <id>]...        # 缺省全部任务
                   [--repeat N]            # 缺省：任务文件各自的 "repeat" 字段（分层预算，缺字段才用 3）；显式传入则覆盖所有任务
                   [--timeout ms]          # 覆盖任务级 timeoutMs
                   [--dsh <path>]          # dsh 的 JS 入口（bin.js）或可执行文件；缺省自动解析（§5.1）
                   [--llm-patch <path>]    # 缺省 bench/llm.patch.yml（存在即用）；--no-llm-patch 关闭注入
                   [--dsh-home <dir>]      # 隔离 DSH_HOME（§2.5/§2.7）；缺省用真实 ~/.dsh
                   [--sleep-ms N]          # repeat 之间的固定间隔，缺省 0
                   [--strict]              # preflight 警告升级为错误（如 home 层 patch 存在时）
                   [--verbose]             # 逐事件现场日志（step/tool/text/stderr）；缺省只打里程碑
                   [--heartbeat-ms N]      # 在跑 run 的"还活着"心跳行，缺省 15000；0 关闭
                   [--stall-ms N]          # 静默多久开始升级警告，缺省 60000；0 关闭
                   [--no-probe-endpoint]   # 关掉 baseURL 的 TCP 连通性预检（缺省会探）
                   [--preflight-only]      # 只跑 §5.1 体检就退出：不建 run 目录、不 spawn 任务、不花 token
                   [--out <dir>]           # 缺省 bench/runs/<UTC>-<label>
                   [--keep]                # 保留临时工作区（默认跑完即删）
                   [--dry-run]             # 只生成 fixture + 对未开工工作区跑 verify（§5.1 判定语义），不 spawn dsh
                   [--list]                # 列出任务后退出
```

流程（每个 任务 × 重复轮次 串行执行，避免自托管服务器并发干扰计时与配额）：

1. `mkdtemp` 临时工作区（`os.tmpdir()/dsh-ops-bench-<task>-r<n>-`）→ 写入 fixture files；
2. spawn `process.execPath [binJs] --profile <p> [--patch <llm.yml>] --json "<prompt>"`
   （§2.7：Windows 上不能直接 spawn `dsh`/`dsh.cmd`；一律 JS 入口 + 参数数组，无 shell），
   `cwd=工作区`，`env=process.env` 透传（`--dsh-home` 时额外覆盖 `DSH_HOME`），
   `stdio: ['ignore','pipe','pipe']`；POSIX 用 `detached:true`（杀进程树用负 pid），
   win32 用 `windowsHide:true`；`<prompt>` 作为单个 argv 传入且不以 `-` 开头；
3. stdout 走 `readline` 逐行：原样追加到 `events.ndjson` + 喂 aggregate + 喂 `lib/observe.mjs`
   的现场叙述器；stderr 落 `stderr.log`，同时（`--verbose` 时）逐行回显；
4. 超时：win32 `taskkill /PID <pid> /T /F`，POSIX `process.kill(-pid,'SIGKILL')`；标记 `timedOut`；
   超时前若静默超过 `--stall-ms`，观察器已经按 1×/2×/4×/8× 打过升级警告；
5. 进程退出后在工作区执行 verify → metrics；
6. 清理工作区（除非 `--keep`）；控制台打一行进度：
   `[3/15] csv-sum r1: exit=0 steps=4 tokens=18,204 in/3,110 out verify=PASS 96s`；
   进度行之外，`lib/observe.mjs` 从 spawn 起就在打**里程碑**（startup OK / 首个请求 /
   `model connection OK` / 缺 usage / 工具错误 / `error` 事件 / turn_end / 结局），
   `--verbose` 再加上逐步逐工具的 chatter；全部级别（含 chatter）追加写
   `<run>/runner.log`，Ctrl-C 之后仍然可读（README §4.1 给出判读顺序）。
7. 全部完成 → 写 `meta.json`、`summary.json`、`report.md`；任一 run `usageReported=false`
   → 控制台显著警告 + report.md 顶部警告（附 2.6 节的服务器排查指引）。

### 5.1 preflight 与 dsh 入口解析（开跑前执行一次）

1. **dsh 入口解析**（`--dsh` 未显式给出时）：
   - win32：`where.exe dsh.cmd` 定位 shim → 读 shim 文本提取
     `node_modules\@deepseek-ai\dsh\lib\bin.js` 绝对路径（npm shim 格式固定：
     `"%dp0%\node_modules\...\lib\bin.js"`）；备选依次试
     `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`、`npm root -g` 输出为根；
   - POSIX：`command -v dsh` 解析符号链接后按同样方法定位包内 `lib/bin.js`；
   - `--dsh` 给出时：`.js` 后缀 → 视为 JS 入口；否则视为可执行文件直接 spawn；
   - 都找不到 → 报错退出，提示全局安装 `@deepseek-ai/dsh` 或用 `--dsh` 显式指定。
   解析后 spawn 一次 `<binJs> --version`，把入口路径与版本写进 meta.json/summary.json。
2. **overlay 校验**：llm-patch 文件存在时 spawn
   `<binJs> --profile <p> --patch <llm.yml> --dump-config`：退出码必须为 0；检查输出里
   `llm-pi-ai` 与 `agent-default-model` 两个补丁都命中（无 "warned and skipped"，§2.7）；
   从中提取 provider/model 供 summary.model 使用。
3. **API key 预检**：从 overlay YAML 解析 `apiKeyEnv` 变量名，检查环境变量或
   `$DSH_HOME/.credentials.yaml` 提供了该凭据——只查存在性、不打印值；缺失 → fail fast，
   别让缺 key 白跑一整轮 run。
4. **home 层污染预检**：`$DSH_HOME/cordis.patch.yml` 存在且非空 → 显著警告（基线可能
   不 stock，§2.7）；`--strict` 时直接报错。`--dsh-home` 隔离模式天然免疫。
5. `--dsh-home` 模式下确认隔离 home 里存在目标 profile，不存在则指向 §8 进阶模式的
   setup 命令。
6. **终端条件预检（§1）**：`PSModulePath` 里若 PowerShell Core 的 `Modules` 根排在 in-box
   Windows PowerShell 之前，且该目录确实带 `Microsoft.PowerShell.Security`
   （纯字符串匹配会在每台 PS7 机器上狼来了），打显著 warning —— 候选侧的 workspace 准备
   会死在 `Get-Acl` 上，症状看起来正是"卡住/什么都不动"。判定逻辑在 `bench/lib/env.mjs`，
   setup 与 preflight 共用。
7. **endpoint 连通性预检**：从 overlay（或组合树）取 `baseURL`，逐个做一次 TCP connect
   （默认开，`--no-probe-endpoint` 关）。不发请求、不认证、不花 token，只回答"这台机器
   现在够不够得着那台服务器"；不通 → warning（`--strict` 拒绝开跑），因为对着黑掉的端口
   跑满超时是这份 harness 最贵的一种白等。
8. **候选插件可见性**：profile 目录下 `node_modules/dsh-ops/package.json` 的版本打出来，
   没装也明说（§2 的 `--reinstall` 语义由此可核）。

首次运行（每个 label 一次）把**带 `--patch` 的** `--dump-config` 输出存档到 run 目录
`dump-config.txt`（公平性证据必须含 overlay 层，§10 第 1 条）。

**`--dry-run` 判定语义**：生成 fixture + 对未开工工作区跑 verify，预期**除 `fileMissing`
类外全部检查失败**（首批 5 任务未用 fileMissing；未来若使用，dry-run 判定需排除该类型——
它在未开工工作区天然通过），否则视为 fixture/verify 自检失败。

## 6. compare.mjs 设计

```
node bench/compare.mjs <base-label|dir> <cand-label|dir>
                       [--aggregate median|min]     # 缺省 median（并列展示 min）
                       [--tolerance-pct 2]          # 门禁容差，缺省 2
                       [--fail-on regression|pass-drop|both|none]   # 缺省 both
                       [--regression-scope task|total|both]  # 缺省 task：逐任务对照容差，
                                                    # 大任务的收益不得再掩盖其他任务的回归；
                                                    # total 仅查 TOTAL 之和（旧行为），both 两个都查
                       [--json <out.json>]
```

- label 解析：在 `bench/runs/` 下按后缀匹配，多个命中取最新；也接受完整目录路径。
- 对齐：按 `taskId` join；每任务把 N 次重复聚合成 median + min + passRate。
- `compare-core.mjs` 纯函数输出：

```json
{
  "tasks": [{ "id": "csv-sum",
    "base": { "grandTotalMedian": 0, "grandTotalMin": 0, "inputMedian": 0, "outputMedian": 0,
              "cacheReadMedian": 0, "firstRequestPromptMedian": 0, "promptTotalMedian": 0,
              "promptPerStepMedian": 0, "stepsMedian": 0, "toolCallsMedian": 0,
              "toolErrorsMedian": 0, "passRate": 1, "repeats": 3 },
    "cand": { "...": "同上" },
    "overhead": { "comparable": true, "fixedOverheadTokens": 0, "extraStepsTokens": 0,
                  "residualTokens": 0, "promptTotalDelta": 0, "outputDelta": 0, "totalDelta": 0 },
    "delta": { "grandTotalPct": -37.2, "stepsPct": -25.0, "toolCallsPct": -40.0,
               "firstRequestPromptAbs": 0, "firstRequestPromptPct": 0 } }],
  "totals": { "baseGrandTotal": 0, "candGrandTotal": 0, "grandTotalPct": 0,
              "basePassRate": 0, "candPassRate": 0,
              "buckets": { "input": { "base": 0, "cand": 0, "delta": 0, "sharePct": 0 },
                           "output": {}, "cacheRead": {}, "grandTotal": {} } },
  "overhead": { "comparable": true, "tasks": 9, "comparableTasks": 9,
                "fixedOverheadTokens": 0, "extraStepsTokens": 0, "residualTokens": 0,
                "promptTotalDelta": 0, "outputDelta": 0, "totalDelta": 0 },
  "warnings": ["model-mismatch", "usage-incomplete:base", "..."]
}
```

  增量分解只做一阶归因，三项相加等于 prompt 侧的 Δ，再加上 `outputDelta` 就是
  grandTotal 的 Δ：`fixedOverheadTokens = (cand 首步 − base 首步) × cand 步数`（每轮都付的
  工具面开销）、`extraStepsTokens = (cand 步数 − base 步数) × base 首步`（多跑几步、按基线
  单价算）、`residualTokens` = 剩下的（工具结果更大/上下文涨得更快）。**门禁只看
  grandTotal**，这三项纯诊断，不参与判定。老归档缺 `prompt` 时 `comparable: false`。

- Markdown 报告（stdout + 写入候选 run 的**上一层目录**：`--folder` 时是
  `bench/runs/<folder>/comparison-<base>-vs-<cand>.md`，平铺时是 `bench/runs/` 下同名文件；
  run 目录是单次归档，不被对比产物污染）：

```
| task        | tokens base→cand (Δ%)      | steps | tool calls | tool errors | pass      |
|-------------|----------------------------|-------|------------|-------------|-----------|
| csv-sum     | 21,314 → 13,400 (-37.1%)   | 5→4   | 6→3        | 1→0         | 3/3→3/3   |
| ...         |                            |       |            |             |           |
| **TOTAL**   | 96,208 → 61,733 (-35.8%)   | 24→17 | 31→19      | 4→1         | 15/15→15/15 |
```

  之后依次是四段诊断（每段都在数据缺失时说 Skipped，不填零）：
  1. **Bucket detail**：逐任务两侧的 input/output/cache read 中位数。
  2. **Per-request overhead**：逐任务首步 prompt 的 base→cand 与 Δ、每步平均 prompt、
     步数，以及跨任务中位的"每次请求固定开销"。
  3. **Where the token delta comes from**：逐任务 + TOTAL 的 Δ 分解
     （固定开销 / 多跑的步数 / 更大的上下文 / Δ output）。
  4. **Token buckets (TOTAL)**：三个桶的 Δ 与各自占 Δ 的百分比——"涨了 54%"和"其中
     89% 是 cache read（计价通常低一个数量级）"是两件不同的事。
  另有 **Tool calls** 表：按工具名汇总两侧所有归档 run 的调用次数，“发布但从没调用”因此
  可见（一侧为 0）。
- 门禁（`--fail-on`）：
  - `regression`：缺省**逐任务**判定（`--regression-scope task`）——任一任务的 cand
    grandTotal(median) > 该任务 base × (1 + tolerance/100) → exit 1（原因带任务名，行内
    标记 `⚠regressed`）。`scope=total` 保留旧的"TOTAL 之和"判定（2026-10-16 扫描中
    csv-sum 的 -67% 掩盖了 bulk-rename 的 +164%，正是它的漏洞）；`both` 两者都查。
  - `pass-drop`：任一任务或 TOTAL 的 cand passRate < base passRate → exit 1；
- 总体数字两个都要看：TOTAL 行 = 语料**成本**（体积加权），GEOMEAN 行 = 各任务 Δ% 的
  几何平均（等权，不受最大任务支配），后者才是"整体效应"的无尺度读数。
- 硬性警告（打印但不阻断）：两侧 model/provider 不一致；任一侧 usage 不完整
  （此时 token 列打印 `n/a`，门禁自动降级为仅 pass-drop）。

## 7. 任务规格

fixture 内容全部现场生成；期望值由生成器导出。目标平台 Windows（bash/宿主 shell 均可完成任务）。

§7.1–§7.5 是首批五个"挑给文件/批量类 ops 工具有油水可赚"的合成任务。
§7.6–§7.9 是 2026-10-16 复盘中补的四个**贴近日常**的场景：它们不挑边，
测的是真实使用里反复出现、而前五个没覆盖的形状——多文件配置的**求值**、
长文件的**分页读**、噪声输出里的**单点定位**、以及带长相符号的**精确改名**。
§7.10–§7.11 是 **256K 档**：workspace 本身约 256K token，用来回答"之前那些差异是不是
因为上下文太短"——短档里"整读"是能负担的（170KB 模块 ≈ 4 万 token），这一档整读越过
dsh 的压缩线（`compaction-basic` 在 0.8 × `contextWindow` 处触发、保留 16%），
于是测量点从"要不要省 token"变成"在 256K 尺度上还能不能有界地取到答案"。
§7.12 是 **长跑档**：workspace 很小（约 90KB），但 fail-fast 的门禁把它拆成至少 24 轮，
量的是反面——每次请求的固定开销与每轮工具输出在几十步的尺度上如何累加。

### 7.1 grep-sweep —— 搜索扫描

- fixture `grepTree{seed:1, dirs:10, filesPerDir:20, linesPerFile:40, needle:"NEEDLE_X7Q", needleFiles:8}`：
  `src/dirNN/fileNNN.js`，共 200 个文件；needle 以 `const MARK = "NEEDLE_X7Q"` 形式恰好出现在
  8 个确定文件里；其余文件保证不含该子串。exports：`matches`（8 个 POSIX 相对路径，字典序）。
- prompt（要点）：找出所有包含精确 token `NEEDLE_X7Q` 的文件，把相对路径按字典序一行一个写入
  `matches.txt`，不要写入其他内容；**每次搜索最多覆盖 50 个文件**（一条递归全树的搜索不合规），
  因此至少 4 次搜索。
- verify：`fileLines matches.txt expect=matches`。
- 打点：搜索工具输出体积（200 文件树的 grep 结果会不会灌爆上下文）、分批搜索的步数；
  "≤50/次"与 bulk-rename 一样是提示词约定，不是判卷条件（verify 只读 `matches.txt`）。
- repeat 2（语料里偏贵，样本向轻任务倾斜）。

### 7.2 bulk-rename —— 批量操作

- fixture `renameTree{seed:2, count:300}`：`data/TEMP_0001.dat … TEMP_0300.dat`，
  每个文件 5 行随机十六进制样式文本。exports：`count=300`、`hashes`（每个文件改后名
  `DATA_NNNN.dat` 的原始字节 SHA-256 清单）。
- prompt：把 `data/` 下所有以 `TEMP_` 开头的文件改名为 `DATA_` 前缀（其余文件名不变），
  不改内容；**每次工具调用最多改 10 个文件名**（一条把 300 个一起改完的循环命令不合规），
  因此至少 30 批。
- verify：`countFiles{dir:"data",prefix:"DATA_",count:300}` + `countFiles{dir:"data",prefix:"TEMP_",count:0}`
  + `contentHashes{dir:"data",expect:"hashes"}`——第三条闭合"删了重建同名空壳也算过"的漏洞，
  改名必须字节不动。
- 打点：**三十批小步**而不是一条大命令——每批 ≤10 个，第 N 批要把前 N-1 批的历史重新带进
  上下文，量的是每步固定开销与批量工具输出体积。注意"≤10/次"是**提示词约定，不是判卷
  条件**：verify 只读最终字节，一条循环命令仍能通过；它测的是遵循度（看 `tool calls` /
  `steps`），不是硬门禁。要门禁化只能让改名走带审计的 helper，代价是任务变成协议题。

### 7.3 csv-sum —— 大文件聚合

- fixture `largeCsv{seed:7, rows:8000, targetRegion:"EU", regions:["EU","US","APAC","LATAM"]}`：
  `data.csv`，表头 `id,region,amount`，amount 为 1..10000 整数。exports：`sum`（精确整数和）。
- prompt：对 `region` 恰为 `EU` 的行求 `amount` 总和，把整数结果（仅此数字）写入 `answer.txt`。
- verify：`fileEquals answer.txt expect=sum`。
- 打点：是否会整读 8 千行进上下文（stock read 工具的代价）vs 一条 shell 聚合命令。
  2026-10-16 扫描：stock 全量 dump 一侧 ~30 万 token、有界采样一侧 ~10 万，是本语料
  判别力最强的任务；rows 从 20000 压到 8000 只为把量级带进 ~10 万档，dump 信号仍在。
- repeat 2（语料里偏贵，样本向轻任务倾斜）。

### 7.4 fix-build —— 多轮错误循环

- fixture `brokenProject{seed:11}`：
  - `package.json`（name/scripts.test="node test.js"，无依赖）；
  - `test.js`：基于 `node:assert` 的 6~8 个断言，require `src/*.js`；
  - `src/` 3 个文件，注入 3 个单行 bug（off-by-one、错误比较运算符、缺失 trim）；
  - **不变式**：修复前 `node test.js` 必失败、正确修复后必通过（单测守护）；
  - exports：`testSource`（test.js 的精确内容，防作弊）。
- prompt：运行 `node test.js`，当前失败；修复 `src/` 里的 bug 使测试通过；不得修改 `test.js`。
- verify：`command{command:"node",args:["test.js"],exitCode:0}` + `fileEquals test.js expect=testSource`。
- 打点：错误-重试循环的轮次与 token；Windows 上 stock PowerShell vs dsh-ops bash 的挣扎差异。
- repeat 4（语料最廉，多买样本压噪声）。

### 7.5 log-stats —— shell 聚合

- fixture `logStats{seed:13, files:50, linesPerFile:400}`：
  `logs/app_00.log … app_49.log`，每行 `INFO|WARN|ERROR` 前缀 + 随机文本。
  exports：`report`（50 行 `"<文件名> <ERROR行数>"`，按文件名字典序，文件名不带 `logs/` 前缀）。
- prompt：统计每个 `logs/*.log` 文件中包含 `ERROR`（区分大小写）的行数，
  按 `<filename> <count>` 格式一行一个写入 `errors.txt`，按文件名字典序，文件名不带目录前缀；
  **每次工具调用最多处理 10 个日志文件**（一条读完全部的循环不合规），因此至少 5 批。
- verify：`fileLines errors.txt expect=report`。
- 打点：5 批小步 vs 一条命令出全表；每批要把前几批的历史重新带进上下文，量每步固定开销；
  "≤10/次"是提示词约定，不是判卷条件（verify 只读 `errors.txt`）。
- repeat 5（模型不 dump 语料时 token 基本不随文件数增长，38k 档只能靠多采样出信号）。

### 7.6 config-hunt —— 分层配置求值（"这个值到底从哪来"）

- fixture `configTree{seed:21, packages:12, env:"production"}`：
  - `README.md` 写明三层合并顺序（`config/defaults.json` → `config/<env>.json` →
    `config/<env>.local.json`，后者覆盖前者），并声明 `packages/*/config.json`
    **不进**应用配置；
  - 四个数互不相同：defaults、env、env.local（答案）、decoy（package 本地文件）；
    另有 `config/development.json` 定义同一个 key，诱导忽略 `APP_ENV` 的模型；
  - exports：`answer`（答案的字符串形式）、`value`、`decoy`、`source`、`layers`。
- prompt（要点）：按 README 的合并顺序，算出 production 下 `MAX_UPLOAD_MB` 的生效值，
  只把这个整数写进 `answer.txt`。
- verify：`fileEquals answer.txt expect=answer`。
- 打点：是"grep 到第一个数就交差"（1/4 概率瞎蒙对），还是读约定再做求值；
  多文件探索的步数与每次请求的固定开销在长探索里的复利效应。
- repeat 2。

### 7.7 big-file-paging —— 长文件里的两段远程读

- fixture `deepModule{seed:23, lines:4200, env:"staging", fnName:"auditLimit"}`：
  单个 `src/pipeline.js`，约 4200 行；
  - 表 `LIMIT_TABLE` 落在文件 ~55% 处，函数 `auditLimit()` 在最后 12 行读它，
    两段相隔 >1/3 文件长度；
  - 诱饵：早段注释里的"历史数值"、被 `LEGACY_LIMIT_TABLE` 取代的旧表，三者互不相同；
  - exports：`answer`、`value`、`stale`、`legacy`、`fnName`、`env`。
- prompt（要点）：`src/pipeline.js` 只导出一个 `auditLimit`，把它在 `'staging'` 下的
  返回值写进 `answer.txt`。
- verify：`fileEquals answer.txt expect=answer`。
- 打点：**从上往下整读 vs 定位到区间只读那两段**。170KB 的模块全读约 4 万 token，
  两次有界范围读只要几百；这是日常最高频的"在一个大文件里找一个答案"形状。
- repeat 2。

### 7.8 noisy-test-triage —— 噪声日志里的单点定位

- fixture `noisySuite{seed:29, tests:2400}`：
  - `runner.js` 打印 2400 行 TAP 风格 `ok N - <name>`（每 250 行插一条 `# progress`），
    其中**恰好一行** `not ok <N> - <name>` 附带 AssertionError 诊断块，退出码 1；
  - 失败名在全量用例里唯一，且不以子串形式出现在任何通过用例名里，也不含失败标记；
  - exports：`failingName`、`failingIndex`、`tests`。
- prompt（要点）：跑 `node runner.js`（必然失败），把失败用例名（`not ok <number> - `
  之后的原文）写进 `failure.txt`。
- verify：`fileEquals failure.txt expect=failingName` +
  `command{node runner.js, exitCode:1, invariant:true}`——第二条把"这题的前提（套件确实在挂）"
  钉成不变式，前提破了 dry-run 会拒绝这题。
- 打点：大输出的裁剪；是 `| grep`/有界搜索找那一行，还是把 6 万字符的日志灌进上下文。
- repeat 2。

### 7.9 api-rename —— 精确改名（含长相符号）

- fixture `symbolTree{seed:31, files:60}`：
  - `src/core.js` 定义 `parsePayload`、`parsePayloadLegacy`、`parsePayloadAsync`，
    其中 `parsePayloadAsync` 的实现**调用** `parsePayload`；
  - `src/` 下 60 个模块：4/5 同时 import 目标符号与 `parsePayloadLegacy`，
    1/5 只 import `parsePayloadLegacy`（改名不应碰到它）；
  - 根目录 `check.mjs` import `decodePayload` 并断言行为，改名完成前必失败；
  - exports：`final`（`src/` 全部文件改后内容的 `{name, sha256}`，供 `contentHashes`）、
    `fixedFiles`（改后内容，供单测自证可答）、`from`、`to`。
- prompt（要点）：把 `parsePayload` 改名为 `decodePayload`（定义、import、调用点），
  `parsePayloadLegacy`/`parsePayloadAsync` 保持原名，**只用文件工具改**（禁止 shell 文本
  替换，如 sed 或脚本），不改行为、不增删 `src/` 下文件，完成后 `node check.mjs` 必须 exit 0。
- verify：`contentHashes{dir:"src", expect:"final"}` + `command{node check.mjs, exitCode:0}`。
  逐文件字节比对意味着"漏改一个调用点"和"顺手改了长相符号"都会挂。
- 打点：**能力探针**——base 的 edit 要先 read，逐文件处理受影响的 ~49 个文件意味着 ~2×49 次
  调用；cand 的 `ops_replace` 支持 `glob`，理论上 3 条字面量替换即可覆盖全部文件。量的是
  跨文件批量替换 vs 逐文件 read+edit，以及由此带出的步数与上下文差；"只用文件工具"是
  提示词约定，不是判卷条件（verify 看不到用了什么工具）。
- repeat 2，`timeoutMs` 1800000（base 侧调用数可能到 100 左右）。

### 7.10 long-corpus-ledger —— 256K 语料上的全量遍历

- fixture `deepCorpus{seed:41, shards:32, charsPerShard:34000, pagesPerShard:10}`：
  - `shards/shard-00.md` … `shards/shard-31.md` 共 32 篇复盘笔记，合计约 1.08MB
    文本（≈254K token）；每篇 ~95% 是散文（全小写词池，永远不含标记），
    结构固定为 `## Charter` / `## Index` / `## Ledger` / `## Archive`；
  - **判据两段分离**：live settlement = `## Ledger` 里 `page=` 等于该篇 `## Index`
    最大页的那一条 `SETTLE`；`## Index` 是乱序的，所以最大页要自己求；
  - 诱饵：`## Ledger` 里另有一条**高于**索引最大页的 stale 页、一条低页、一条索引内
    非最大页；`## Archive` 里还有两条 `VOID SETTLE`（其中一条页号最大）。因此
    "第一条 SETTLE""文件里最高页""ledger 里最高页"三种偷懒读法都是错的；
  - 全语料 amount 互不相同（同一 seed 下逐字节可复现），32 行报告无法猜；
  - exports：`report`（`shard-NN <amount>` 共 32 行）、`shards`、`chars`。
- prompt（要点）：`README.md` 写明规则，逐 shard 求 live settlement，
  按 shard 升序把 `shard-NN <amount>` 写进 `report.txt`，不夹带别的行。
- verify：`fileLines report.txt expect=report`。一行一个 shard，**少一个 shard 就少一行**，
  所以"覆盖整个语料"是被判卷强制的，不是靠 prompt 请求的。
- 打点：256K 尺度下的**有界遍历**——逐文件定位 + 只带两个字段前进（或一条脚本），
  对比"把 32 篇读进上下文"。这条路径在 256K 窗口里不再可行：整读约 254K token，
  dsh 在 0.8 × `contextWindow` 处压缩。工具面能不能让模型少走回头路，是这一题问的。
- repeat 2，`timeoutMs` 1800000。

### 7.11 deep-module-256k —— 单文件的两段远程读（256K 档）

- fixture `deepModule{seed:47, lines:27000, env:"staging"}`：与 §7.7 同生成器、同形状，
  只是 4200 行 → 27000 行（约 1.08MB，≈254K token）。活表在 ~55% 处，
  `auditLimit()` 在最后 12 行读它，两个诱饵（历史注释、`LEGACY_LIMIT_TABLE`）互不相同。
- prompt（要点）：同 §7.7——`src/pipeline.js` 只导出 `auditLimit`，
  把它在 `'staging'` 下的返回值写进 `answer.txt`。
- verify：`fileEquals answer.txt expect=answer`。
- 打点：**这是 §7.7 的长上下文对照**。4200 行时整读约 4 万 token，负担得起，
  所以 9 题那轮里"要不要分页"是偏好问题；27000 行时整读约 25 万 token，
  越过 256K 窗口的压缩线，分页/区间读从"省一点"变成"能不能做完"。
  两题一起看，就能把"短上下文里的差异"和"256K 尺度上的差异"分开。
- repeat 2，`timeoutMs` 1800000。

### 7.12 gate-repair-loop —— 长跑档（24 个 fail-fast 阶段）

- fixture `gatePipeline{seed:53, gates:24, probes:40, linesPerGate:70}`：
  - `gates/gate_00.js` … `gates/gate_23.js`：24 个阶段模块，每个约 70 行惰性填充
    （变量名带阶段号与行号，不可能撞名），模块头写明**契约**（加多少、乘多少、
    对多少取模），而 `run()` 里绑定的常量与契约**差一个值**——每个阶段恰好一处缺陷，
    由生成器逐行比对强制（报 `changed.length !== 1` 而不是靠注释承诺）；
  - `check.js`：按序 import 全部阶段，对每个阶段跑 40 个探针值与 golden 表比对，
    **在第一个不一致处停下并 exit 1**（`process.exitCode`，不走 `process.exit`，
    免得截断管道里的 stdout），全绿时打印 `# final value <n>`；
  - 链的输入 `seedValue=7` **不在探针里**：把 golden 表背下来的阶段在链上会算错，
    `answer.txt` 就不过——所以"记住答案"不是一条捷径；
  - exports：`answer`（最终值字符串）、`final`、`checkSource`（防篡改基准）、
    `gates`、`probes`、`fixes`（24 个修好后的模块，供单测把门禁跑绿）。
- prompt（要点）：跑 `node check.js`，它逐阶段校验并在第一个不符处停下；修 `gates/`
  直到 exit 0；门禁通过时打印的最终值写进 `answer.txt`；不许改 `check.js`/`package.json`、
  不许增删文件。
- verify：`command node check.js` exit 0；`fileEquals answer.txt expect=answer`；
  `fileEquals check.js expect=checkSource invariant=true`（防篡改守卫，dry-run 豁免）。
- 打点：**这是 §7.10/§7.11 的反面对照**。那里 workspace 巨大、轮数很少；这里 workspace
  约 90KB、轮数由 fail-fast 结构锁在 24 以上，且第 N 轮的日志约为 N 行块（末轮 ~22KB，
  全循环累计 ~270KB）。于是同一套工具面要**重复付几十次**：报告的
  `## Per-request overhead` 是每次请求的固定开销，`## Where the token delta comes from`
  里"多跑的步数"与"更大的上下文"两项在这里第一次成为主项——短跑里被"少跑两步"抵消的
  固定开销，长跑里无处可藏。
- 配平旋钮：`gates`（最少轮数 = 步数下限）、`probes`（每轮日志行数 = 每步要重带的工具输出）、
  `linesPerGate`（单个阶段模块的读取体积）。动这三个数就是动口径，两侧必须重跑。
- repeat 2，`timeoutMs` 2400000（24 轮 × 每轮至少一次运行，默认 900s 不够）。

## 8. Windows 环境搭建（写进 bench/README.md 的主体）

前置条件（缺一不可，run.mjs preflight 会逐项自检）：

- `@deepseek-ai/dsh@0.2.0-rc.2` 已全局安装（npm），`dsh --version` 正常；
- **pnpm 已安装且在 PATH**（`dsh plugin` 透传 pnpm，缺失时 exit 127，§2.3）；
- node 满足 `engines`（`^22.19 || >=24`），且 **PATH 上的 `node` 也满足**
  （任务内模型自跑 `node test.js`，§4.5）；
- OpenAI 兼容 token 服务器在线，流式响应支持 `stream_options.include_usage`（§2.6）。

一次性准备：

```console
:: 1) 创建两个 profile（已确证只初始化、不跑任务，§2.3。
::    注意不幂等——对已存在的 profile 重跑会报错，存在即跳过本步）
dsh bench-base --from-default-profile headless --dump-config >NUL
dsh bench-ops --from-default-profile headless --dump-config >NUL

:: 2) 候选 profile 安装被测插件（可复现性优先 published 版本或 npm pack tarball；
::    本地目录是 file: 快照拷贝语义，checkout 改动后要重装，§2.3）
dsh plugin --profile bench-ops add dsh-ops@0.3.0
dsh plugin --profile bench-ops add .\dsh-ops-0.3.1.tgz
dsh plugin --profile bench-ops add C:\path\to\dsh-ops-checkout
```

LLM endpoint 配置——**不手工改 profile 的 cordis.patch.yml**，改用 `--patch` overlay
（§2.7；run.mjs 对每次 dsh 调用自动注入，两 profile 共用同一份，公平性由构造保证）：

```console
:: 3) 复制模板并填写你的服务器（llm.patch.yml 在 .gitignore，不进仓库）
copy bench\llm.patch.example.yml bench\llm.patch.yml

:: 4) 设置 API key 环境变量（patch 文件里只有变量名，密钥不进任何仓库文件；
::    也可写入 %USERPROFILE%\.dsh\.credentials.yaml，POSIX 上须 chmod 600）
setx BENCH_SERVER_API_KEY "sk-..."
```

`bench/llm.patch.example.yml` 模板内容（provider 路由名可自定，两处保持一致）：

```yaml
# 复制为 bench/llm.patch.yml（gitignore）后填写你的服务器；run.mjs 以 --patch 把它
# 传给每次 dsh 调用（含 dump-config 存档）→ 两侧 provider/model 一致由构造保证。
- id: llm-pi-ai
  config:
    providers:
      bench-server:
        baseURL: https://<你的服务器>/v1
        apiKeyEnv: BENCH_SERVER_API_KEY
        api: openai-completions
        models:
          - id: <模型id>
            # 256K 档（§7.10/§7.11）需要这一项真的 ≥ 262144：dsh 的 compaction-basic
            # 在 0.8 × contextWindow 处压缩、只保留 16%，填小了会先压缩再答题。
            contextWindow: 262144
            maxTokens: 16384
- id: agent-default-model
  config:
    provider: bench-server
    model: <模型id>
```

冒烟自检（确认 usage 上报，见 2.6；在临时目录里跑，别把 ok.txt 和会话留在仓库）：

```console
mkdir %TEMP%\dsh-bench-smoke && cd /d %TEMP%\dsh-bench-smoke
dsh --profile bench-base --patch <repo>\bench\llm.patch.yml --json "Write the single word OK into ok.txt"
:: 检查输出的 step_end 事件里有没有 usage 字段；没有 → 先解决服务器 include_usage
```

进阶模式（可选）：隔离 DSH_HOME——彻底避开 home 层 patch 污染与 `~/.dsh/sessions`
累积（§2.5/§2.7），清理 = 删目录：

```console
set DSH_HOME=D:\bench\dsh-home
:: 对隔离 home 重跑步骤 1-2（创建 profile + 装插件，pnpm 会装进隔离 home），
:: 之后所有 run.mjs / 冒烟命令都带 --dsh-home D:\bench\dsh-home
```

日常对比：

```console
node bench/run.mjs --label bench-base --profile bench-base --repeat 3
node bench/run.mjs --label bench-ops  --profile bench-ops --repeat 3
node bench/compare.mjs bench-base bench-ops --fail-on both
```

README 还需包含：会话目录清理提示（2.5；`--dsh-home` 模式下无需）、方差与免责声明
（第 10 节口径）、`--dry-run`/`--list` 用法、如何新增任务（4.1/4.2 格式，含"prompt
不得以 `-` 开头"约束）、以及 **bench 不在根 `package.json` 里挂 npm script** 的说明：
`bench/` 是仓库自用的测量工具，发布包的主干入口要保持干净，所以唯一入口是
`node bench/run.mjs`；门禁仍由 `node test/run.mjs bench`（`test/bench.test.mjs`）负责。

## 9. 仓库接线

- **根 `package.json` 不加 bench scripts**：`bench/` 是仓库自用的测量工具，入口只有
  `node bench/run.mjs` / `bench/setup.mjs` / `bench/compare.mjs` 三条，发布包的主干
  scripts 表要保持干净（`files` 也不含 `bench/`，它本来就不进包）。
- `.gitignore` 增加：`bench/runs/`、`bench/llm.patch.yml`（用户填写副本，含服务器
  地址；模板 `bench/llm.patch.example.yml` 正常提交）。
- `test/bench.test.mjs`（进现有 `node test/run.mjs` 门禁，任何平台可跑，不 spawn dsh；
  注意门禁有 **120s/suite 硬超时**——fixture 单测用小参数，勿反复生成 2 万行 CSV /
  300 文件树）：
  - fixtures：同 seed 两次生成逐字节一致；各生成器 exports 与内容自洽
    （matches 恰好 12 个且非目标文件不含 needle；csv sum 与重新遍历一致；
    brokenProject 修复前 `node test.js` 失败）；
  - verify：7 种检查类型的通过/失败路径（临时目录内）；
  - aggregate：喂 2.2 节形状的合成 NDJSON → 精确断言各计数与 usage 求和；
    缺 usage 的 step → `usageReported=false`；坏行 → `malformedLines`；
  - compare-core：合成两份 summary → Δ%、median/min、passRate、门禁判定、
    model-mismatch 与 usage-incomplete 警告。
- 不动 README.en.md / README.zh.md（避免与上游 docs 重构冲突）；发现性靠
  `bench/README.md`（主干入口不挂 bench，所以也不指望 `npm run` 把它带出来）。需要时后续再在主 README 加一行链接。

## 10. 方法论与免责声明（报告固定脚注）

1. **公平性锚**：两侧 profile 必须同 provider、同 model、同上下文/输出配置——由两侧
   共用同一份 `--patch` overlay 保证（§2.7）；run 目录保存**含 overlay 层的**
   `dump-config.txt` 作为证据；compare 检测到不一致即警告；home 层 patch 的存在由
   preflight 拦截（§5.1）。
2. **方差**：模型输出非确定；单次差异在噪声内没有意义。采样预算分层：任务文件用
   `repeat` 字段声明自己的预算（当前语料 2~5 档，每侧合计 16 次），显式 `--repeat N`
   统一覆盖；正式对比每任务建议 ≥3，报告同时给 min 以观察离散度。
3. **通过率是门禁的一半**：token 降了但任务做不对 = 无效优化（fix-build 还有
   test.js 防篡改校验）。
4. **口径**：grandTotal=四桶之和（cacheRead/cacheWrite 是否"省钱"取决于计价，
   自托管服务器无所谓，但报告分桶展示以便映射到计价模型）。
5. **自测声明**：结果只描述"这台机器、这个模型、这组任务、这个时间"的测量，
   不构成可外推的官方节省百分比（对齐 PROVENANCE.md 的口径约束）。
6. **两个 node 版本**：verify 的 `command:"node"` 用 run.mjs 的 `process.execPath`，
   任务内模型自跑的是 PATH 上的 `node`；summary 记录两者版本（§4.5），README 要求
   二者都满足 `engines`。

## 11. 实施步骤清单（Windows 侧按序执行）

| # | 步骤 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| 0 | 环境自检：`dsh --version`、**pnpm 在 PATH**、node ≥22.19（run.mjs 与 PATH 两份）、token 服务器在线 | 版本打印正常 | 自检项已实现（preflight）；服务器在线需人工 |
| 1 | `bench/lib/fixtures.mjs`（5 生成器 + PRNG） | 单测：确定性、exports 自洽 | ✅ 已实现，门禁覆盖 |
| 2 | `bench/lib/verify.mjs` | 单测：7 类检查通过/失败路径 | ✅ 已实现（`command` 检查口径见 §13.1） |
| 3 | `bench/lib/aggregate.mjs` | 单测：合成 NDJSON 精确聚合 | ✅ 已实现 |
| 4 | `bench/lib/tasks.mjs` + 5 个 `*.task.json` + `bench/llm.patch.example.yml` | `run.mjs --list` 打印 5 任务；结构校验通过（含 prompt 不以 `-` 开头） | ✅ 已实现，`--list` 实测通过 |
| 5 | `bench/run.mjs`（bin.js 入口解析、--patch 注入、preflight、--dry-run/--keep/--dsh-home/--strict/超时杀树） | win32 上能经 JS 入口 spawn dsh；preflight 全绿；`--dry-run` 按 §5.1 语义失败 | ✅ 代码落地；`--dry-run`/`--list`/stub 端到端已实测，真机 preflight 需在普通终端跑一次 |
| 6 | profile 搭建 + `bench/llm.patch.yml`（第 8 节）+ **smoke 确认 step_end 带 usage** | smoke 事件流里 usage 字段存在 | ⬜ 需要一台在线的 OpenAI 兼容服务器 |
| 7 | 两侧各跑 1 任务 × repeat 1（真模型） | metrics/summary/report 落盘，verify=PASS | ⬜ 依赖步骤 6 |
| 8 | `bench/lib/compare-core.mjs` + `bench/compare.mjs` | 单测通过；对步骤 7 的两个 run 出报告 | ✅ 代码与单测落地；真实存档对比待步骤 7 |
| 9 | `test/bench.test.mjs` 全量接入 | `node test/run.mjs bench` 绿 | ✅ 40 项检查绿（管道受限的环境里 stub 端到端检查自我跳过并说明原因） |
| 10 | 全量：5 任务 × 2 profile × repeat 3 | 两份 summary + 对比报告；人工复核一份 events.ndjson | ⬜ 依赖步骤 6–7 |
| 11 | `bench/README.md`、`.gitignore`（runs/ + llm.patch.yml）、~~package.json scripts~~（后已移除：主干入口不挂 bench，见 §9） | 文档可从零复现步骤 6-10 | ✅ 已实现 |

预估代码量：lib 四件套 ~700 行，run/compare（含 preflight 与入口解析）~550 行，
任务 JSON ~120 行，单测 ~250 行。

> **落地状态**：步骤 1–5、8–9、11 已完成——代码 + `test/bench.test.mjs`（41 项检查）全绿，
> `--list`、`--dry-run` 与"stub 启动器端到端一轮 + compare 出报告/门禁"均已实测；
> 步骤 0、6、7、10 需要一台能连 OpenAI 兼容服务器的 Windows x64 机器上手执行。
> 落地过程中对设计的四处必要修订见 §13（以 §13 为准）。

## 12. 已知风险与对策

| 风险 | 对策 |
| --- | --- |
| 服务器流式不回 usage（2.6） | 步骤 6 前置冒烟；harness 明确降级为"仅步数/工具计数"并拒绝 token 结论 |
| ~~`--dump-config` 不触发 profile 初始化~~ **已销案：源码确证会初始化（§2.3）** | 派生新风险：对已存在 profile 重跑 `--from-default-profile` 会 throw → setup 幂等（先探测目录，存在即跳过） |
| Windows 上 spawn `dsh`/`dsh.cmd` 不可行（§2.7） | 设计已消除：解析 bin.js 入口 + `process.execPath` 启动，无 shell；`--dsh` 可显式覆盖 |
| home 层 `cordis.patch.yml` 污染基线（§2.7） | preflight 检查 + 显著警告（`--strict` 拒绝）；`--dsh-home` 隔离模式天然免疫；dump-config.txt 存档可审计 |
| pnpm 缺失 / 本地 checkout 安装语义（§2.3） | preflight 与 §8 前置自检；README 优先 published 版本或 tarball；本地目录是快照拷贝，改动需重装 |
| API key 缺失白跑一轮 run | preflight 只查 apiKeyEnv 凭据存在性（不打印值），fail fast（§5.1） |
| 任务文本以 `-` 开头被解析为选项（§2.1） | tasks.mjs 结构校验固定语料约束；spawn 参数顺序固定为 §2.7 |
| 模型把 prompt 当耳旁风（如仍改了 test.js） | verify 防作弊检查；passRate 进对比报告 |
| 临时工作区在 `os.tmpdir()`，Windows 路径含空格/中文 | spawn 用数组参数不经 shell；路径全程 `path.join` |
| 会话目录在 `~/.dsh/sessions` 累积 | README 清理指引；不自动删（不碰用户数据）；`--dsh-home` 隔离模式下会话落 benchmark 自有目录，删目录即清（§2.5） |
| 长任务卡死（服务器慢/模型死循环） | 每任务 timeout + 进程树击杀 + `timedOut` 标记计入失败 |
| repeat 期间服务器热状态不同（KV cache 等） | 串行执行；报告 cache 桶分列；repeat 间固定间隔用 `--sleep-ms`（已列入 §5 CLI） |

## 13. 实现落地记录（代码落地时确定的四处修订，以本节为准）

代码已按 §1–§12 落地：`bench/run.mjs`、`bench/compare.mjs`、`bench/lib/{fixtures,verify,aggregate,tasks,compare-core}.mjs`、
`bench/tasks/*.task.json`（5 个）、`bench/README.md`、`test/bench.test.mjs`（进 `node test/run.mjs` 门禁）。
落地时对设计做了四处**必要**修订：

1. **`command` 检查只比退出码，不捕获子进程输出**（修订 §4.3）。
   `spawn(..., { stdio: 'ignore' })` 而不是 pipe：该检查的判定本来就只看退出码，而捕获输出
   要求父进程能开命名管道——受限沙箱里的 `node test/run.mjs` 开不了管道会抛 `EPERM`，
   那会把"任务其实通过了"变成"harness 报错"。门禁因此在任何环境都可用。
   `run.mjs` 自己读 `dsh --json` 的 stdout 仍然必须用管道（那是测量本体），
   所以它在 preflight 里显式自检并拒绝在受限会话中跑（见第 4 条）。
2. **文件类检查比较前把 CRLF 折成 LF**（修订 §4.3）。
   `fix-build` 的 `fileEquals test.js` 是防篡改检查：Windows 上的编辑工具重写同一个文件时
   很可能顺手换行，按字节全等会把"内容没改"的 run 误判成失败。比较语义仍是 trim 后全等，
   只是不再对换行风格敏感。
3. **新增 `verify[].invariant` 标记，`--dry-run` 的判定改为按检查语义期望**（修订 §5.1）。
   `fix-build` 的防篡改检查在**未开工**的工作区上本来就该通过，原"除 fileMissing 外全部失败"
   的一刀切规则会把它误报成 corpus 缺陷。现在：`fileMissing` 与 `invariant: true` 期望通过，
   其余期望失败，两个方向都不对就算自检失败。
4. **preflight 增加"能否管道 spawn"自检，入口发现不依赖 spawn**（补充 §5.1 第 1、2 步）。
   入口发现改为 PATH 目录扫描 + 读 shim 文本（不 spawn `where.exe`/`which`），
   只在确实需要读输出时才 spawn；受限会话里 `run.mjs` 立刻给出可执行的解释
   （换普通终端跑），而不是把 token 花在注定失败的 run 上。
