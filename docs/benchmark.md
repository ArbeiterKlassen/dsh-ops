# Local benchmark lane

`bench/run.mjs` is a deliberately separate, local-only stress harness. It is not imported by `npm run verify`, is not a test suite, and refuses to run when `GITHUB_ACTIONS` is set. It writes JSON and Markdown reports to `.tmp-bench/` by default (the directory is ignored).

## Run

Build or stage the native worker first when the checkout does not already have one:

```sh
npm run build:ptc
npm run bench -- --iterations 10 --concurrency 8
```

The benchmark resolves the worker through `lib/ptc/runtime.js`, then measures one-shot native worker cold/warm process launches, concurrent requests, bounded large output, and read-only mutation refusal. When the real Cordis host APIs and worker are available it additionally measures plugin mount/tool calls and host-side prompt/tool surface accounting. Unavailable capabilities are recorded as `skipped` with their reason; no result is fabricated.

The report includes an environment fingerprint, worker version, scenario status, latency samples and summary percentiles, output sizes, SHA-256 hashes for the visible tool schemas and assembled prompt sections, byte counts, and a conservative bytes/4 token estimate. The estimate is for comparisons only, not a tokenizer result.

The harness uses a throwaway `DSH_HOME` and workspace under the system temporary directory. It does not change production runtime code, profile configuration, permissions, or CI workflows. Desktop GUI acceptance, Windows ACL restoration, and persistent worker protocol behavior remain outside this lane and are called out in the report.

Focused utility tests run with:

```sh
npm run test:bench
```
