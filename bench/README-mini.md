# Benchmark

## 测试前的准备

```console
npm ci --ignore-scripts
npm run build && npm run build:ptc     # lib/ + 原生 worker
```

### 再准备 dsh + 两个 profile

```console
npm i -g @deepseek-ai/dsh
node bench/cli.mjs setup              # 先加 --dry-run 看计划；检查失败会在碰 profile 之前拒绝
```

### 配 LLM 路由 overlay

跑 `node bench/cli.mjs setup` 会在副本不存在时自动复制一份（存在就一字不改）；想自己重来一份就手动复制，会覆盖已有的：

```console
cp bench/llm.patch.example.yml bench/llm.patch.yml           # bash
```

填 `bench/llm.patch.yml`：

- `baseURL`：服务器地址，如 `https://host/v1`
- `<model-id>` ：模型 id，两处必须一致
- `apiKeyEnv`：放密钥的环境变量名，如 `BENCH_SERVER_API_KEY`
- `contextWindow` / `maxTokens`：模型真实窗口 / 单次输出上限（默认最大 256K 上下文，单次最大 32K 输出）

密钥只放在 `~/.dsh/.credentials.yaml` 的 `ref` 节点下面的环境变量里面，这样避免出现在项目源文件、对话的上下文

## 怎么跑全量

```console
node bench/cli.mjs ab --folder full-sweep-34
node bench/cli.mjs ab --show        # 只看计划：打印每对的顺序，不 spawn、不花钱
```

- 全量 = `bench/tasks/` 下 6 个任务 × 每个 2 次 × 2 臂 = 12 对 24 个会话，一个进程串行跑完，奇数轮 base→cand、偶数轮 cand→base；
- 不给 `--folder` 会自动取下一个空闲的 `benchmark-test-NN`；Ctrl-C 中断时已跑完的会话照样写成摘要，不丢；
- 默认不写 `run.json`：每臂留 `results/` + `summary.json`，报告用 `report` 生成（见下节）；要那份封存文档才加 `--seal`（它会先 dump 两侧 profile 做指纹，约 0.4s，取不到就在 spawn 之前拒绝）。

## 怎么跑单个 task

```console
node bench/cli.mjs ab --task csv-sum --repeat 1 --folder probe-csv-sum
```

- `--task` 可重复传多个，只跑点名的那些；id 写错会在跑之前退 2，并把已知 id 列出来；
- 不给 `--repeat` 就用任务自带的预算（当前 6 个都是 2），`--repeat 1` 只跑一轮；
- 现成的 6 个 id：`api-rename`、`big-file-paging`、`config-hunt`、`csv-sum`、`gate-repair-loop`、`noisy-test-triage`；
- 加 `--show` 先确认要跑哪几对，再摘掉它真跑。