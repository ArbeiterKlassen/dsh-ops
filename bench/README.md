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
node bench/cli.mjs ab
```

- 会自动取下一个空闲的 `benchmark-YYYY-MM-DD-NN`（按当天日期编号，从 `-00` 起）
- 跑完自动在组目录写 `DSH-OPS Benchmark Report <UTC>.md`（报告标题带 (beta)）

## 怎么跑单个 task

```console
node bench/cli.mjs ab --task csv-sum
```