# bench 使用说明（按当前代码）

`bench/` 是仓库自带的测量工装：**只在 checkout 里跑、不随 npm 包发布、不进默认门禁**。
所有路径都从模块位置解析，在哪个工作目录下调用都一样；每个子进程都不经过 shell，参数原样传递。
模型驱动的部分需要一个可用的 dsh 与 LLM 路由，脚本门禁复用仓库已有的 devDependencies（`js-tiktoken`、`@deepseek-ai/*`）。

本文按仓库当前源码写成，覆盖：跑之前的准备、怎么跑全量、怎么只跑一个任务、怎么出报告、
每个测试用例的含义（以及各自主要考察哪些 `ops_*` 工具）、临时文件与证据落在哪里。
同目录的 `bench/README.md` 描述的是更早的形态（例如 seal 已接线、语料里还有后来删掉的任务），
两者冲突时以本文与源码为准。

---

## 0. 三套工装，先分清

| 套件 | 入口 | 用模型 | 断言什么 | 主要产物 |
| --- | --- | --- | --- | --- |
| 模型驱动 A/B | `node bench/cli.mjs ab` → `report` → `panel` | 是 | **通过率先行**；成本方向只在有 A/A 噪声底时才读 | 每臂 `bench/runs/<组>/<UTC>-<label>/` 下的 `summary.json` + `results/`、报告 `.md`；加 `--seal` 另有组目录 `run.json` |
| 脚本验收门禁 | `node bench/cli.mjs gates` | 否（确定性 provider 脚本） | BM-01…BM-05 的固定工作负载：字节、schema token、CAS 冲突、权限拒绝 | `--output <新文件>.json` + 同名 `.md` |
| 工具级确定性对比 | `node bench/cli.mjs tools` | 否 | 只有 `MATCH` / `EXPECTED_DIFFERENCE` / `EXPECTED_REJECTION` 算通过 | `--out <新文件>.json` |

三条共同底线：

1. **永不裁决时间**。median / 耗时只打印，只作人类证据，进不了任何门禁。
2. **证据独占创建**。`gates` 的 `--output`、`tools` 的 `--out` 都必须是不存在的文件，重跑不会覆盖上一次的证据。
3. **失败要响**。`report` / `gates` / `tools` 的退出码就是裁决；弃权（如噪声底未知）明确说出口，不伪装成通过。

### 当前接线状态（这一段能省半小时）

| 命令 | 状态 |
| --- | --- |
| `setup` / `report` / `panel` / `tools` / `gates` | 已接线，`--help` 退 `0` |
| `ab` | 已接线：一个进程跑完两臂（按 `(task, repeat)` 奇偶 AB/BA 交错）；默认只写每臂 `results/` + `summary.json`，**加 `--seal` 才写组目录下的 `run.json`** |

带 `--seal` 时，runner 会先用 `dsh --profile <名> --dump-config` 取两侧 profile 的指纹（各一次，几百毫秒），
写进 `arms[].profileHash`；取不到指纹就在 spawn 任何会话之前拒绝，不花 token。`sealRun` 随后把两臂的
`results/` 折成组目录下的 `run.json`（`schemaVersion: 1`，契约见 `bench/run.schema.json`）。

不带 `--seal` 就是普通跑：`results/` 与 `summary.json` 一样写，`report` 与 `panel` 都读得了 `summary.json`
（`panel` 会提示 `schemaVersion n/a`）。`--no-seal` 仍然表示"不要封存"，也就是默认值。

---

## 1. 跑之前的准备

### 1.1 三种套件都要：装依赖 + 构建

```console
npm ci --ignore-scripts
npm run build          # src/ -> lib/（gates 直接 import lib/ 与 lib/components/*）
npm run build:ptc      # 构建并 stage 原生 worker（gates 的 --worker 默认指向它）
node --version         # 需要 ^22.19 || >=24
```

`gates` 默认使用 `native/target/release/dsh-ops-worker`（Windows 下是 `dsh-ops-worker.exe`）；
`setup` 的 preflight 会跑 `node bin/native-runtime.mjs check --platform <platform>-<arch>` 校验
`runtime/<tag>/` 里的 worker 与来源凭据，缺了就**在碰 profile 之前**拒绝。

### 1.2 只跑 A/B（模型驱动）还要：dsh + 两个 profile + LLM overlay

```console
npm i -g @deepseek-ai/dsh        # 或者稍后给 --dsh <...>/lib/bin.js
node bench/cli.mjs setup --dry-run    # 先看计划：打印每一步写入与命令，什么也不改
node bench/cli.mjs setup              # 真跑：preflight 通过后创建两个 profile
```

`setup` 的顺序是故意的：先 preflight（权限组合、`PSModulePath`、本地构建），**检查失败就在碰 profile
之前拒绝**；一套注定会"量的是权限模式"或"跑的是旧构建"的配置，改 profile 也修不好。

preflight 之后它会：

- 把 `bench/llm.patch.example.yml` 复制成 `bench/llm.patch.yml`（仅当后者不存在；存在就一字不改，它是操作员的）；
- 从模板（默认 `headless`）克隆出两个 profile：`bench-base`（基线）与 `bench-ops`（候选，默认装本 checkout 的本地构建）。
  profile 写在 `$DSH_HOME/profiles/<标签>/cordis.patch.yml`（没设 `DSH_HOME` 就是 `~/.dsh`；`--dsh-home` 可隔离到别处）；
- 把两侧的 shell 引擎（默认 5.1 `powershell.exe`）与权限模式（默认 `danger-full-access`）钉进各自的 patch 层，
  再用 `dsh --dump-config` 读回来确认——写进文件和"真的生效"是两件事；
- 打印跑 sweep 的那一条命令。

常用旗标（完整列表看 `node bench/cli.mjs setup --help`）：`--dsh-home <dir>` 隔离 DSH_HOME、
`--plugin <spec>`（`local` / npm spec / `none`）、`--reinstall`、`--no-build-check`、`--force`、`--dry-run`。

**填 overlay**（A/B 跑之前必须做一次）：把服务器、模型 id、`apiKeyEnv` 填进 `bench/llm.patch.yml`。

- 密钥只放环境变量或 `~/.dsh/.credentials.yaml`，**绝不写进这个文件**；
- 默认 overlay 是隐式注入的，归档里会把 `--llm-patch <path>` 补进命令行；
- 确实要让两侧各跑各自 profile 自带的路由，用 `--no-llm-patch`（runner 会把"两侧不共享任何路由"说出口）；
- 默认 overlay 缺失又没给 `--no-llm-patch` 时，runner 在 spawn 之前退 `2` 并点名文件与两条出路。

**噪声底**：A/A 是"基线跟自己对"。默认未知 ⇒ 成本门弃权，报告只给 Δ、不给方向。

```console
node bench/cli.mjs ab --aa --repeat 2 --folder aa-noise-01
```

之后比较时二选一：`--noise-floor-pct N`（固定已测半宽）或 `--noise <base> <cand>`（用两次基线跑现测）。

### 1.3 只跑 gates（脚本门禁）还要：0.3.1 基线树 + 基线 worker

BM-01 的权威比较对象是 **OPS 0.3.1**（提交 `4b51b6333213c376c8b7c173c12f35b408fdec2d`）。缺基线不是跳过，是失败。

```console
git fetch --unshallow                          # 浅克隆必须先补历史，否则拿不到 0.3.1 的 blob
node bench/gates/prepare-baseline.mjs baseline-031   # 拒绝覆盖已存在的目录
cargo build --release --locked --manifest-path baseline-031/native/Cargo.toml
# Windows: --baseline-worker 指向 ...\dsh-ops-worker.exe
```

`prepare-baseline.mjs` 直接按 Git blob 落盘（不经过 checkout 的换行转换、不依赖 tar），
`provenance.mjs` 随后逐 blob 复算 SHA-1、并校验基线 worker 自报 `dsh-ops-worker 0.3.1`。

**BM-03 的 Windows Bash**：完整 bash 契约需要一个可选夹具。在专用临时 `DSH_HOME` 里
`node bin/dsh-ops.mjs bash-runtime install`，再把 `DSH_OPS_TEST_BASH` 指到校验过的绝对路径。
全新目录没有 Bash 时，BM-03 正确**阻塞**，而不是只数文件工具的小分数。

**输出文件名**：`--output` 与它的 `.md` 都拒绝覆盖，重跑换一个新名字。

### 1.4 只跑 tools 还要：两个 worker 可执行文件

```console
node bench/cli.mjs tools --baseline <worker-a> --candidate <worker-b> --out bench/runs/<新目录>/tools-01.json
```

两侧可以指向同一个二进制——那只证明"harness 还能驱动真实 worker、两轮答案一致"，**不构成任何性能结论**。

---

## 2. 怎么跑全量

### 2.1 A/B 全量（模型驱动）：6 任务 × 2 次 × 2 臂 = 12 对 24 个会话

```console
node bench/cli.mjs ab --folder full-sweep-34
# 想先看它会怎么跑（纯函数，不 spawn、不花钱）：
node bench/cli.mjs ab --show
```

- 默认语料是 `bench/tasks/*.task.json` 的全部任务；每个任务自带 `repeat` 预算（当前都是 `1`）；
- 每次 dsh 调用都带 `--patch bench/llm.patch.yml`（除非 `--no-llm-patch`）；
- 一个进程跑完两臂，奇数轮 base→cand、偶数轮 cand→base，**串行**，一次一个会话；
- 组目录只分配一次：`bench/runs/<folder>`；不给 `--folder` 时自动取下一个空闲的 `benchmark-YYYY-MM-DD-NN`（按当天日期编号，从 `-00` 起）；
- 常用附加旗标：`--seal`（额外写 `run.json`）、`--no-report`（关掉跑完自动写的 md 报告）、`--sleep-ms`、`--heartbeat-ms`、`--stall-ms`、`--timeout <ms>`、
  `--model <id>`、`--verbose`、`--keep`（保留每个临时工作区）、`--dsh <path>`。
  `--label` / `--profile` 属于旧的"每臂一个进程"形态，runner 会直接拒绝。

跑完的屏幕摘要是：会话数/配对数、每侧通过数、两侧 token 与 Δ、配对数、噪声底、门禁结论、seal 结果
（`--seal` 时写进哪个 `run.json`；没封存就明确说 "not requested"）、报告落点
（`DSH-OPS Benchmark Report <UTC>.md` 写进组目录；`--no-report` 或 sweep 被打断时明确说没写）。

真实例子：`bench/runs/full-sweep-33`（2026-10-21）base 臂 13:02:34Z 起跑，组目录里的报告时间戳是
13:15:32Z，全量约 13 分钟。

### 2.2 gates 全量：BM-01…BM-05

```console
node bench/cli.mjs gates \
  --baseline-source baseline-031 \
  --baseline-worker baseline-031/native/target/release/dsh-ops-worker \
  --output bench-evidence/2026-10-24-windows.json
```

不给 `--task` 就是五项全跑。判据：

- 全部选中项 `passed` → 退 `0`；
- 任一项 `failed` 或不可用（如 BM-03 缺 Bash、BM-04 没有已集成的 PDF 能力）→ 退 `1`；
- 参数错误或缺少构建输入 → 退 `2`。
- 选中项成功**不等于**五项都过：报告里 `Selected gates passed` 与 `All five gates accepted` 是两个字段。

### 2.3 tools 全量

```console
node bench/cli.mjs tools --baseline <worker> --candidate <worker> --out bench/runs/<新目录>/tools-full.json
```

默认语料是 5 个尺寸边界族，其中 `small-files` 与 `deep-tree` **各有 10000 个 4 KiB 文件**（全量会真的建两万个文件，
先留好时间与磁盘）。先热身 1 次、再 5 轮交替配对；同二进制时它只证明 harness 没坏。**冒烟用 `--scale 0.01`**：
缩放只作用于文件**数量**，33 MiB 拒绝、8 MiB hex 窗口、1 MiB 行边界永远保留。

---

## 3. 怎么只跑某一个任务

| 套件 | 单任务开关 | 备注 |
| --- | --- | --- |
| A/B | `--task csv-sum` | 可重复传多个；默认 `--repeat` 用任务自带预算，可用 `--repeat 1` 覆盖 |
| gates | `--task BM-02` | 只接受 `BM-01`…`BM-05`；可重复传 |
| tools | `--scale 0.01` | 语料没有"单个用例"的开关，缩放文件数即可快速冒烟 |

A/B 单任务（先计划后执行）：

```console
node bench/cli.mjs ab --task big-file-paging --repeat 1 --show
node bench/cli.mjs ab --task big-file-paging --repeat 1 --folder probe-paging
```

- 任务 id 写错会在跑之前退 `2`，并列出已知 id；
- `--folder` 与 `--out <dir>` 二选一：`--out` 直接指定本次 sweep 的目录，不能再给 `--folder`；
- 想固定两侧标签（默认 `bench-base` / `bench-ops`）用 `--base` / `--cand`，标签同时是 profile 名。

门禁单任务：

```console
node bench/cli.mjs gates --task BM-02 --worker native/target/release/dsh-ops-worker --output bench-evidence/bm02.json
```

BM-02 / BM-03 / BM-04 / BM-05 不需要基线；只有 BM-01 要 `--baseline-source` + `--baseline-worker`，
缺了不是跳过，而是把 BM-01 记成 `failed`（`BM-01 requires --baseline-source and --baseline-worker; missing baseline is not a pass`）。

---

## 4. 怎么生成测试报告

### 4.1 A/B 报告（模型驱动）

```console
node bench/cli.mjs report bench-base bench-ops --folder full-sweep-34
# 只要机器可读的比较文档：
node bench/cli.mjs report bench-base bench-ops --folder full-sweep-34 --json --out -
```

- 两侧可以写 label（在 `bench/runs/*-<label>` 与 `bench/runs/<folder>/*-<label>` 里找，最新时间戳优先）、
  一个 run 目录，或者 `run.json` / `summary.json` 的路径；
- 默认落点是**当次跑的组目录**，文件名带写入时刻：`bench/runs/<组>/DSH-OPS Benchmark Report <UTC>.md`
  （UTC 形如 `2026-10-21T13-15-32Z`，冒号换横线）。重跑一次就是一份新报告，不覆盖上一份；
- 直接挂在 `bench/runs/` 下、没有组目录的跑，报告留在自己的 run 目录里；
- **注意**：`--seal` 出来的 `<组>/run.json` 是**两臂合在一起**的文档，别把它当"一侧"传给 `report`；比较照旧用两个
  label 或两个 arm 目录（它们读各自的 `summary.json`），`run.json` 是给 `panel` 和归档用的；
- `--out <file>` 指定落点，`-` 只到 stdout；`--json` 让文件/标准输出承载比较文档而不是报告。

判决旗标（**跑报告就等于跑门禁**）：

| 旗标 | 含义 |
| --- | --- |
| `--fail-on both`（默认） | 先判通过率，再判 token |
| `--fail-on pass-drop` / `regression` / `none` | 只判通过率 / 只判 token / 只出报告 |
| `--regression-scope task\|total\|both` | token 回归判每个任务、判总量还是都判（默认 `task`） |
| `--tolerance-pct N` | 回归容忍带，默认 `2` |
| `--aggregate median\|min` | Δ 比较用的统计量（默认 median） |
| `--noise-floor-pct N` / `--noise <a> <b>` | 给噪声底；不给就弃权（`noise-floor-unknown`） |

退出码：`0` 正常或成本门弃权 · `1` 门禁失败 · `2` 用法/输入错误。

**怎么读报告**（顺序别跳，正文与标题是英文）：

1. `Per-task pairs`：`task | base | cand(Δ%) | steps | tool calls | tool errors | pass`，数值单元格自带括号 Δ%，
   以 `TOTAL` 行收尾；
2. `Tool calls (per-side overlap counts)`：每个工具一行，`base`/`cand` 是整轮合计，后面每个任务一列，格子是 `base → cand`。
   **`ops_*` 计数上升标绿、下降标红；其它工具相反**；两侧都没调用写 `—`，相等不标色；
3. `Per-task bucket detail` / `usage split` / `steps and tool calls`：诊断用，不改判决；
4. `Warnings` 与 `Evidence`：列出无法支撑结论的行，以及 `run.json` / 归档路径；
5. `Conclusion`（最后一段）：通过率、配对 token Δ、噪声底、方向、门禁与判定理由——顺序就是判决顺序。

着色只是包一层 `<span style="color:…">`，数字不改写；GitHub 会剥掉 `style`，在那边退化成纯文本。

### 4.2 门禁报告（gates）

`--output <file>.json` 写 JSON，同名的 `<file>.json.md` 写 Markdown，**两个都独占创建**。
Markdown 的结构：平台/host/Node 一行 → `Selected gates passed` / `All five gates accepted` → 门禁状态表 →
BM-01 逐案例字节表（候选 / 0.3.1 / 官方读取器 / 两个节省比例）→ 主案例的轮数表 →
无损下界（源码自身字节 vs 40% 目标）→ 每个门禁的 schema token 明细 → BM-05 的 gates JSON。

JSON 里保留了精确输入、夹具哈希、规范化结果、模型可见文本、请求 schema 与比较来源，便于复核。

### 4.3 工具级报告（tools）

`--out <新文件>.json` 独占创建，控制台打印表格；时间只作为证据打印，**不参与判定**。
只有 `MATCH`、`EXPECTED_DIFFERENCE`、`EXPECTED_REJECTION` 是"预期结果"，其余状态（含 `MISMATCH`、
`UNSTABLE`、`TIMEOUT`、`ERROR`、`WORKER_ERROR`）都退 `1`。

> 名字对照：设计议题里曾把不匹配写作 `UNEXPECTED_DIFFERENCE`，代码里的名字是 `MISMATCH`。

### 4.4 面板（panel）

```console
node bench/cli.mjs panel --out bench/runs/<组>/<UTC>-bench-ops bench/runs/<组>/<UTC>-bench-ops/summary.json
node bench/cli.mjs panel --serve bench/runs/<组>/<UTC>-bench-ops --port 0
```

- `panel.html` **不内联数据**：它只带数据文件的*名字*，查看时 `fetch` 同目录的 JSON，所以要把 HTML 写在数据文件旁边；
- 支持 `run.json`（加 `--seal` 才有），也支持默认跑出来的 `summary.json`（提示 `schemaVersion n/a`）；
- `--serve` 只绑 `127.0.0.1`、只服务那一个目录、不常驻、不发请求、不写 `~/.dsh`；
- `file://` 双击时浏览器会拦 `fetch`，页面提供文件选择/拖拽回退；
- 五个标签：概览 / 对话 / 轨迹 / 判卷 / 原始 JSON。

---

## 5. 测试用例含义（以及主要考察哪些 `ops_*` 工具）

### 5.1 模型语料：`bench/tasks/*.task.json`（6 个）

字段白名单是 `id / title / prompt / fixture / verify / repeat / timeoutMs`，多一个字段就是拼写错误并点名文件与字段。
`prompt` 是模型唯一看到的东西。判卷类型只有 8 种：`fileExists / fileMissing / fileEquals / fileContains /
fileLines / countFiles / contentHashes / command`。几个容易写错的语义：

- `fileEquals` **两侧都 `trim()`**，行尾换行不算差异；`fileLines` 逐行 `trim()`、丢空行、折叠 CRLF；
- `contentHashes` **只看直接子项**（不递归），逐个比对名字与原字节 SHA-256，并拒绝任何多出来的文件
  （候选写下的 `.dsh-ops-update-*.lock` 边车被排除）。它是"改名而不是重写"的判据：删掉重建或截断能骗过
  `countFiles`，骗不过它；
- `invariant: true` 标记"任务开始前就必须成立的护栏"（防篡改/防改题），例如 `check.js` 的字节不变、runner 仍然失败。

| 用例 | 工作量 | 判卷 | 主要考察的 `ops_*` 工具 |
| --- | --- | --- | --- |
| `api-rename` | `src/` 下 12 个模块 + `src/core.js`（另生成 `check.mjs`）；`repeat 1`，30 min | `contentHashes(dir: src)` 全等（13 个直接子项的名字与原字节 SHA-256）+ `node check.mjs` 退 `0` | 搜调用点：`ops_grep`（+`ops_glob`）；读文件：`ops_read_files`；改名：`ops_edit_file` 或 `ops_replace`。诱饵 `parsePayloadLegacy` / `parsePayloadAsync` 与完全不碰该符号的文件必须原样保留 |
| `big-file-paging` | `src/pipeline.js` 4200 行；`repeat 1`，15 min | `answer.txt` 等于 `auditLimit('staging')` 的整数 | 定位：`ops_grep`；只读两段：`ops_inspect_local_file`（或 `ops_read_files`）带 `offset`/`limit`；写答案：`ops_write_file`。文件里还留着过期注释与被取代的 `LEGACY_LIMIT_TABLE`，grep 一次仍要判断 |
| `config-hunt` | `README.md` + 3 层 JSON + 12 个 `packages/*/config.json` 诱饵；`repeat 1`，15 min | `answer.txt` 等于 `MAX_UPLOAD_MB` 的有效值 | 找层：`ops_glob`；找 key：`ops_grep`；读优先级文档与三层：`ops_read_files`；写答案：`ops_write_file`。只 grep key 就停下会拿到 1/4 概率的错答案 |
| `csv-sum` | `data.csv` 8000 行；`repeat 1`，15 min | `answer.txt` 等于 EU 金额整数和 | 别把 8000 行进上下文：`ops_bash`（聚合）、`ops_read_files`（只看表头）、`ops_write_file`。语料跑在 Native 面，PTC 是另一套投影，不在本套语料路径上 |
| `gate-repair-loop` | 24 个 stage 模块（每个约 70 行）+ `check.js`；`repeat 1`，40 min | `node check.js` 退 `0` + `answer.txt` 等于最终值 + `check.js` 字节不变（invariant） | 跑门禁：`ops_bash`；读 stage：`ops_read_files`；按契约修那个常量：`ops_edit_file`；写答案：`ops_write_file`。每个 stage 只错一处绑定常量，契约写在模块自己的注释里 |
| `noisy-test-triage` | `runner.js` 2400 个测试、恰好一行 `not ok`；`repeat 1`，15 min | `failure.txt` 等于失败测试名 + runner 仍退 `1`（invariant） | 跑并落盘：`ops_bash`（重定向到文件）；在日志里只捞那一行：`ops_grep`（如 `^not ok`、`outputMode: summary/content`）；必要时 `ops_read_files`；写结果：`ops_write_file`。答案必须精确，猜不中 |

同一份报告里的 `Tool calls` 表就是这条设计的实测镜像：插件工具接住了 → `ops_*` 计数**上升**是绿；
候选还在伸手够插件没覆盖的工具 → 其它工具上升是红。

### 5.2 脚本门禁：BM-01…BM-05（`bench/gates/`）

跑在固定的真实 host（DSH `0.2.0-rc.2` 的 AgentLoop / Session / 工具派发 / 权限服务）上，
模型响应是确定性脚本——**不发网络模型请求、不产生计费 token**。测的是工具行为、文本与轮数，不是模型质量。

| 门禁 | 测什么 | 主要考察的 `ops_*` 工具 |
| --- | --- | --- |
| BM-01 | 三个 70/80/90 行的 TS 文件各取**前 50 行**：一次 `read_files` 对比 OPS 0.3.1 与官方 `read`；先断言规范化数据与模型可见文本都完整保留请求行，再比字节。判据：一个带工具的 provider 轮次 + 相对 0.3.1 至少省 40%（官方读取器单列、不决定验收） | `ops_read_files`（多文件多区间一次调用）对比 `ops_inspect_local_file`、官方 `read`；敏感性网格另有 8/1/32 行、约 600 字符长行、转义 Unicode |
| BM-02 | 单文件五处编辑一次提交成功；随后两次外部改动造成的**旧 CAS 冲突**必须全部拒绝（`REVISION_CONFLICT`）且文件字节不变；回执不许复读整文件 | `ops_edit_file`（`expectedRevision` + 多个 hunk） |
| BM-03 | 真实第一次 provider 请求的默认 Native 面 schema：精确清单（含发现入口；Windows 还要求完整 Bash 契约与 jobs 服务），缺失/重复/意外工具都**阻塞**；用 `js-tiktoken@1.0.21` 的 `cl100k_base` 数紧凑 `name/description/parameters` JSON。已批准的 ≤400 token 只作用于文件/发现小计，Bash 仍常驻、完整总数单列 | `ops_read_files` + `ops_discover_tools`（小计），`ops_bash`（另列），整份启动消息 JSON 再单列 |
| BM-04 | 真实单页 Helvetica/Flate PDF：初始无 PDF schema → 第一次发现后，**所属** provider 的下一次请求必须可见，兄弟 agent 不可见，然后验证抽取文本 | `ops_discover_tools` → `ops_read_pdf`。目录里还没有受评审的 PDF 读取器时，该门禁是 `blocked` |
| BM-05 | 工作区外的凭据围栏读取与越界写入都必须 `rejected`、`effectState: none`、文件不变，且不泄露被拒父路径或秘密正文；同时要求"普通可读的外部文件"这个允许对照成功。固定 host 不提供全面的工作区读取围栏，报告里明说 | `ops_read_files`（`CREDENTIAL_DENIED`）与 `ops_write_file`（`POLICY_DENIED`） |

### 5.3 工具级语料：`bench/tools/index.mjs`（无模型）

固定尺寸边界，`SEED = 870016`，改它就让所有归档报告失去基线。五个夹具族：

| 族 | 边界 / 用例 |
| --- | --- |
| `small-files` / `deep-tree` | 10000 个 4 KiB 文件；`grep` 无命中（summary）、`glob` 带排除与分页；目录里还埋了 `node_modules`、`.hidden`、`target`、`.venv`，以及一条 31 层 `d/` 的深树 |
| `big-file` | 33 MiB 文件必须被拒（`OUTPUT_LIMIT`）、8 MiB 文件的 hex 窗口必须能读；`grep` 在混合目录下仍要命中 |
| `dense-hits` | 200 个"每行多命中 + 中文"的文件；`summary` / `count` / `content` 三种输出模式与带 offset/context 的分页 |
| `edge-text` | 1 MiB 单行、带 BOM/引号/反斜杠/制表符/NUL 的 Unicode、非法 UTF-8、4095 字节处正好断在中文前的边界 |
| 两个 worker | 同一套用例分别喂给 `--baseline` 与 `--candidate`，逐项比对状态、输出与错误信封 |

### 5.4 想加一个任务

把 `bench/tasks/<id>.task.json` 放进目录即可（`loadTasks` 按文件名排序读全量）：

- `fixture.generator` 必须是 `bench/lib/fixtures/index.mjs` 注册表里的名字之一
  （当前 11 个：`grepTree / renameTree / largeCsv / brokenProject / logStats / configTree / deepModule /
  deepCorpus / noisySuite / symbolTree / gatePipeline`）；
- `verify` 非空，检查项的 `expect` 命名的是 fixture 导出的期望值，键写错会直接抛
  `fixture exports have no key "..." (known: ...)`，不会静默失败；
- `prompt` 不能以 `-` 开头（headless launcher 会当选项）、不能以空白开头、不能含 NUL；
- `repeat` 是每任务预算（`1..100`），`timeoutMs` 默认 900000，合法区间 `1000..86400000`。

---

## 6. 临时文件与证据落在哪

`bench/runs/` 与 `bench/llm.patch.yml` 都在 `.gitignore` 里：一次跑的数据是"某台机器上发生过什么"，不是源码。

| 位置 | 谁写的 | 生命周期 |
| --- | --- | --- |
| `%TEMP%\dsh-ops-bench-<task>-r<n>-XXXXXX`（POSIX 为 `$TMPDIR`） | `bench/run/session.mjs`，`mkdtemp` 在每个会话自己的根下 | 夹具写在这里，dsh 以这里为 cwd 跑；验证读完就删。`--keep` 保留，路径记在行的 `workspace` 字段里 |
| `bench/runs/<组>/<UTC>-<label>/results/<task>-r<n>.events.ndjson` | 会话驱动 | 事件流，写入期按 NDJSON 追加（崩溃安全） |
| `…/results/<task>-r<n>.stderr.log` | 同上 | dsh 子进程的 stderr |
| `…/results/<task>-r<n>.trace.ndjson` | 同上 | 时间线：`tool_call` / `tool_result` / 里程碑 / 心跳 / stall |
| `…/results/<task>-r<n>.metrics.json` | 同上 | 该行的汇总：exit / steps / toolCalls / durationMs / usage 分桶 / 逐项 verify / 归档指针 |
| `bench/runs/<组>/<UTC>-<label>/summary.json` | `bench/run/schedule.mjs` | 每臂聚合 + 配对 + 门禁结论。**先写摘要再封存**：被 Ctrl-C 打断的 sweep 也留下可读的记录 |
| `bench/runs/<组>/run.json` | `bench/run/seal.mjs` 的 `sealRun`（**只在带 `--seal` 时**） | 两臂合体的封存文档，`schemaVersion: 1`；读者遇到未知版本必须拒绝 |
| `bench/runs/<组>/DSH-OPS Benchmark Report <UTC>.md` | `bench/compare.mjs` | 报告默认落点；一次运行一份，不覆盖 |
| `<--out 指定的目录>/panel.html` | `bench/report/panel.mjs` | 查看器，不内联数据 |
| `%TEMP%\ops-bm040-XXXXXX\` | `bench/gates/index.mjs`，`mkdtemp` + `realpath` | 门禁的独占夹具目录，内含 `dsh-home/`（只改这一个 `DSH_HOME`，绝不动操作员的 HOME/profile）与每个门禁一个子目录（BM-01 的 `typescript-first-50`、`typescript-8`、`typescript-1`、`typescript-32`、`long-lines-8`、`unicode-json-8`，BM-02 `five-edits`，BM-03 `startup`，BM-04 `pdf-discovery`，BM-05 `authority-workspace` + `outside`）。**故意保留**供检查，脚本不做广泛清理 |
| `%TEMP%\dsh-ops-file-bench-XXXXXX`（可换 `--temp-dir`） | `bench/tools/index.mjs` | 工具级夹具；生成在计时之外，跑完先**整树盘点**再删除，遇到不是自己创建的内容就报错并保留现场 |

清理建议：`bench/runs/` 只增不减（现在已经有几十个历史组），报告与 `summary.json` 都是证据，删之前先确认
里面没有你要引用的那一次；临时目录里的 `ops-bm040-*` 是故意留的，看过就能删。

---

## 7. 命令速查

```console
# 准备
npm ci --ignore-scripts && npm run build && npm run build:ptc
node bench/cli.mjs setup --dry-run
node bench/cli.mjs setup

# 全量
node bench/cli.mjs ab --folder full-sweep-34            # 默认：只写每臂 summary.json + results/
node bench/cli.mjs ab --seal --folder full-sweep-34     # 额外封存组目录的 run.json
node bench/cli.mjs gates --baseline-source baseline-031 --baseline-worker baseline-031/native/target/release/dsh-ops-worker --output bench-evidence/<new>.json
node bench/cli.mjs tools --baseline <worker> --candidate <worker> --out bench/runs/<new>/tools.json

# 单任务
node bench/cli.mjs ab --task csv-sum --repeat 1 --show
node bench/cli.mjs gates --task BM-02 --output bench-evidence/bm02.json

# 报告
node bench/cli.mjs report bench-base bench-ops --folder full-sweep-34
node bench/cli.mjs report bench-base bench-ops --folder full-sweep-34 --json --out -
node bench/cli.mjs panel --out <数据文件所在目录> <run.json|summary.json>

# 帮助 / 版本
node bench/cli.mjs --help
node bench/cli.mjs <setup|ab|report|panel|tools|gates> --help
node bench/cli.mjs --version
```

退出码：`0` 正常（或成本门弃权）· `1` 失败/门禁失败 · `2` 用法与输入错误 · `3` 声明了但目标未接线
（缺文件，或文件存在但没导出 `main(argv, io)`——绝不静默成功）。