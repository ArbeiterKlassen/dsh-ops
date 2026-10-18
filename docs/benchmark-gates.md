# Scripted acceptance benchmarks

中文：[基准门禁](基准门禁.md).

`node bench/cli.mjs gates` runs the BM-01–05 scenarios through the pinned DSH `0.2.0-rc.2` AgentLoop, Session, tool dispatch and authority services. A deterministic provider selects the calls; no paid model or network model request is made. The suite measures tool behavior, text and round counts, not model quality or billing tokens. It is opt-in and is not part of the default functional gate.

```console
npm ci --ignore-scripts
npm run build
npm run build:ptc
node bench/gates/prepare-baseline.mjs baseline-031
cargo build --release --locked --manifest-path baseline-031/native/Cargo.toml
node bench/cli.mjs gates --baseline-source baseline-031 --baseline-worker baseline-031/native/target/release/dsh-ops-worker --output benchmark-gates.json
```

On Windows append `.exe` to the baseline worker. To measure the complete Bash surface, first install an optional fixture into a dedicated temporary `DSH_HOME` with `node bin/dsh-ops.mjs bash-runtime install`, then set `DSH_OPS_TEST_BASH` to its validated absolute executable (the release gate uses the same fixture API). The benchmark records this explicit selection; it changes no schema options. A fresh home without an installed Bash correctly blocks BM-03 instead of counting only the file schemas. The manual workflow acquires this fixture explicitly. Use a new output filename for each run. The command refuses to overwrite either JSON evidence or its `.md` summary. It retains its exclusively owned temporary fixture directory for inspection. `--task BM-02` selects one gate; selected success never means that all five passed. Any failed or unavailable selected gate exits 1; malformed arguments or missing build inputs exit 2.

The manual `Opt-in OPS acceptance benchmarks` workflow runs the same command on Windows x64, Linux x64 and Apple Silicon, independently builds the baseline, and uploads both artifacts even when a gate fails. It changes no default CI requirement and uses no model credentials.

## Fixed workloads and comparisons

| Gate | Evidence and criterion |
| --- | --- |
| BM-01 | Three files with 70/80/90 TypeScript lines, each requesting its first 50 lines, as declared in the issue prose. Compare one `read_many` call with separately named OPS 0.3.1 and pinned official `read` results. Canonical and emitted text must retain exactly the requested lines before measuring bytes. Report sequential three-round and parallel one-round baseline controls separately; report total provider requests including the final answer. Both 40% comparisons remain individually visible. |
| BM-02 | Five distinct edits in one file, one successful submission, then two externally changed stale-CAS cases. Verify exact resulting bytes, all conflicts rejected, and no full-file echo. |
| BM-03 | Measure actual first provider schemas for the full default Native surface. Windows includes the published Bash contract with the real jobs service; absence blocks the gate. Count compact `name/description/parameters` JSON with exact `js-tiktoken@1.0.21`, `cl100k_base`. Keep whole startup messages separately. The full ≤400 target remains pending; no narrower scope is silently substituted. |
| BM-04 | A real one-page Helvetica/Flate PDF. No PDF schema initially; discovery request one must expose `pdf_read` in provider request two, without sibling visibility; then verify extracted text. Missing integrated PDF capability is blocked. |
| BM-05 | Real credential-fenced outside reads and workspace-escaping writes must return rejected, preserve files, and reveal no denied parent path or secret body. An ordinary OS-readable outside read is a separately labelled allowed control: the pinned host does not implement a blanket workspace read jail. |

BM-01 also always reports offsets 13/31/51 with 8 lines, plus 1-line, 32-line, 600-character-line and escaped Unicode/JSON sensitivities. The frozen fixture definitions, file hashes and fixture-source hash appear in evidence. There is no automatic workload selection to obtain a favorable threshold.

The 0.3.1 baseline is commit `4b51b6333213c376c8b7c173c12f35b408fdec2d`. The preparation script materializes exact Git blobs without checkout newline conversion; provenance rechecks every `lib/` and `native/` blob and records the worker version and SHA-256. Binary reproducibility is not attested. The official comparator uses the installed, pinned host reader separately. The test-only jobs package `@deepseek-ai/dsh-jobs-local@0.2.0-rc.2` was published on 2026-09-29, more than seven days before addition; it is needed to measure the complete Bash schema.

## Honest limits and retained results

The earlier worker/renderer-only 3×8 probe recorded 2,256 baseline and 1,949 candidate bytes (13.608% reduction), with `modelRounds: null` and `hostAuthorityExercised: false`. This remains limited historical evidence.

The subsequent real AgentLoop primary case recorded 8,883 OPS 0.3.1 bytes, 5,457 official-reader bytes and 6,239 candidate bytes. Replaying those unchanged canonical receipts through the compact renderer gives 5,348 bytes: 39.795% below 0.3.1, still below 40%. The final integrated host rerun remains required.

The primary source lines alone occupy 4,320 UTF-8 bytes. Forty percent below the 5,457-byte official result requires at most 3,274.2 bytes, so that comparison cannot pass without source omission or compression even before path/revision/coverage labels. The report includes this numerical lower bound and an illustrative absolute-path/range label size; shared-base layouts can reduce the latter. Long source lines likewise prevent universal percentage savings. Output paths, host contracts and formatter revisions affect measured bytes, so all exact receipts remain attached.
