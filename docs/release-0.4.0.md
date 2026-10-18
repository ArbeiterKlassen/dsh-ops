# 0.4.0 release candidate

中文：[0.4.0 发布候选](0.4.0发布候选.md).

**Not released.** Version fields identify this candidate; they do not authorize a tag, npm publication
or a final merge. Functional CI and the five acceptance benchmarks are separate gates. BM-01 and the
full default BM-03 are still failing, so release remains blocked.

## Implemented surface

The package declares seven stable rows: shell, file, PTC, discovery, panel, TUI and official-tool
replacement. Fresh file/PTC/discovery rows are on; shell is on only on Windows; panel/TUI/replacement
are off. Existing named overrides and explicit switches survive restart. An enabled fresh panel starts
collection; legacy explicit capture:false remains inert. Turning it off stops queued filesystem work.

Native starts with read_many and discover, plus usable Windows Bash. Advanced tools activate only in
the owning agent's next provider request. The PTC SDK catalogue contains 19 APIs: 16 file/document tools,
batch, result and sdk. The complete shared catalogue also includes bash and discover (21 entries).
The SDK and Native projections expose separate typed/text outputs; catalogue membership is not startup
residency. Current scopes, allowed pools and permissions still govern publication and every call.

The one-shot Rust worker checks authority per call. Native text is bounded and uses reversible line
escaping; PTC returns typed Outcomes. References preserve source scan/page/capture completeness and do
not grant filesystem access. Same-content re-read suppression requires exact provider-input evidence;
retained message history alone is insufficient. See [re-read evidence](context-read-dedup.md).

All plugin source is strict TypeScript/TSX. The build rejects JavaScript under src, compiles to lib,
and preserves shipped .js paths. Repository scripts/tests may remain JavaScript; lib/runtime are build
artifacts. Follow [source-build instructions](CONTRIBUTING.md), not an unbuilt Git install.

## Document scope

| Tool | Supported scope | Main bounds and exclusions |
| --- | --- | --- |
| table_read | CSV/TSV lexical string cells; strict UTF-8 or BOM-consistent UTF-16LE/BE | 32 MiB input, 100000 data rows, 1 MiB/record, 1024 columns, 30 s. No XLS/XLSX, formula evaluation or type coercion. |
| doc_read | DOCX main-body paragraphs, including table coordinates | 32 MiB archive, 8 MiB main XML, 1 MiB/paragraph, 100000 paragraphs, 30 s. No binary DOC, macros, encrypted/ZIP64 archives, external fetch or disk extraction. Excludes layout, headers/footers, notes/comments and metadata. |
| pdf_read | PDF 1.3–1.7 classic-xref text layer; standard Helvetica/Courier/Times Type 1 with Standard/WinAnsi | 16 MiB input, 32 pages, 1 MiB/page/stream, 16 MiB decoded and 16 MiB processed streams, 30 s. No OCR, images, general layout, forms, custom/embedded/CID fonts, ToUnicode, encryption, incremental or object/xref streams. |

These are bounded readers, not general office/PDF converters. Unsupported later content retains safe
preceding complete records with an error and next action. Offsets cannot skip a physical scan gap.
Only a stable full scan yields total/revision; a complete displayed or stored page does not repair
incomplete source coverage. See [detailed document contracts](native-kernel.md).

## Operator changes

Bash and PowerShell are not npm payload dependencies. Managed Bash install/removal and Git Bash
selection are explicit. Windows restricted execution remains partially enforced and requires the
compatible pinned MSYS runtime; approval does not create missing confinement. Host PowerShell upgrade
previews the standard installation; execute explicitly, restart DSH, and review any custom pwshPath.

Built-in row forms persist validated settings through the host. Optional browser pages need the
explicit offline settings-profile migration because the pinned host loads its browser facet only
from a bare package carrier. The default legacy file row remains supported. The migration preserves
seven IDs/configs, makes backups and checks exact composition; disabling the carrier unloads custom
pages. Re-enable through the host row switch. See [configuration](configuration-reference.md).

## Issue #261 acceptance matrix

This maps the original 16-part plan to the integrated implementation. Named suites identify concrete
regressions and proof boundaries; they are not a claim that pending final CI or manual checks passed.
The detailed limits above and in linked contracts remain part of acceptance.

| Plan step | Implemented behavior and limits | Evidence / remaining decision |
| --- | --- | --- |
| 1 — Build | src → lib build and assets preserve published paths; source Git installs require a build. | build and packed-artifact gates; JavaScript migration allowance removed in step 16. |
| 2 — Contracts | One capability catalogue; typed Outcome, error/retry, coverage and reference contracts. | kernel-types, kernel-errors and schema checks; Native text and PTC data remain distinct. |
| 3 — Native projection | Numbered reversible source text, bounded receipts and explicit incomplete output; 64 KiB escaped display cap. | native-projection, native-line-encoding, native-ranges; no universal percentage saving. |
| 4 — Worker | Workspace crates and v1 bounded one-shot requests, authority rechecked per call. | Cargo workspace and protocol regressions; persistent IPC remains deferred to a separate security review. |
| 5 — Reads, edits, search | Up to 32 independent read ranges; atomic multi-edit within one file; honest search gaps/continuations. | file-batching-worker and search regressions; no cross-file atomic edit or complete total after a scan gap. |
| 6 — References/budgets | 10 MiB/result, 100 MiB/session; two active/eight waiting calls and 30-second worker ceiling; audit data separate. | result-references/spill/lifecycle, call-budget, native-result; permission-limited cleanup can leave invalidated temp blobs. |
| 7 — PTC | 19 typed SDK APIs, three resident entries; allowed pools and next-step loading independent of Native. | ptc-outcome/schema/sdk and progressive-loop; current frozen SDK cannot call queued APIs. |
| 8 — Discovery | Native allowed pool, always-loaded subset and 1–5 selections; owning agent's next request only. | discovery/composition and real AgentLoop BM-04; no filesystem permission grant. |
| 9 — Resident surface | read_many plus discover, with eligible Windows Bash; advanced tools absent initially. | Exact provider inventory; full Windows BM-03 is 660 tokens, so the ≤400 target is unresolved. |
| 10 — Re-read evidence | Exact successful body in the latest completed ordinary provider request plus fresh file checks. | context-read-dedup/many with real replacement/projection; missing evidence restores full output. |
| 11 — Bash | Host approvals/jobs/subprocess, absolute executor, 120/600-second timing, optional managed/Git Bash. | shells-host/execution/manager; Windows confinement remains partial and runtime compatibility is mandatory. |
| 12 — PowerShell | No bundled payload or executor overlay; explicit standard host upgrade plan and execution. | Host runtime manager/transport regressions; no real operator installation performed; restart/custom-path review required. |
| 13 — Replacement | Opt-in read/glob/grep with exact OPS definition identity and readiness; read maps to inspect_local_file. | Real scoped mount/readiness regressions; write/edit replacement is excluded because CAS contracts differ. |
| 14 — Migration/settings | Seven stable rows, saved overrides, fresh defaults and physical panel stop; validated built-in forms. | platform-defaults, settings-host/UI/client/carrier/runtime and panel-stop; custom pages need optional offline carrier; real TUI requires a separate host. |
| 15 — Documents | Discoverable CSV/TSV, DOCX and restricted classic-xref PDF readers with honest safe prefixes. | table/docx/pdf worker+host suites and BM-04; unsupported formats/layout/OCR remain excluded, as detailed above. |
| 16 — Acceptance/release | Strict TS/TSX, versioned candidate, paired docs and separate opt-in BM-01–05 evidence. | Functional CI and benchmark acceptance are separate; BM-01/BM-03 fail, so no final release approval. |

## Stacked review and staging rollout

The review PRs currently use predecessor branch bases to keep each diff bounded; they do not all
target release/0.4.0 directly. For example, [1/16](https://github.com/T-Auto/dsh-ops/pull/264)
targets release/0.4.0, [2/16](https://github.com/T-Auto/dsh-ops/pull/265) targets its toolchain branch,
and [14b/16](https://github.com/T-Auto/dsh-ops/pull/283) targets the 14a settings branch. The 15a–d
and 16a reviews continue from their preceding slice. PR number alone is not dependency order: part 13
was opened earlier, while its current base is part 12.

Maintainers review and integrate prerequisites into release/0.4.0 in plan/dependency order: 1;
2→3 and 4a→4b; then 5a→5b, 6a→6b→6c→6d, 7–13, 14a→14b, 15a→15b→15c→15d and 16a→16b→16c.
When prerequisites are present in staging, retarget the next review to the appropriate current base,
verify that its diff contains only the intended slice, and rerun required CI after any integration
change. Do not merge a successor into an obsolete predecessor merely because it remains the review
base. Keep shared history intact; this work does not merge maintainers' PRs.

Only after all required functional gates and acceptance decisions are resolved should maintainers
review release/0.4.0 → main as the final release PR. BM-01 needs an explicit decision about the fixed
lossless workload/comparator requirement; BM-03 needs an explicit decision about full startup residency
versus the 400-token budget while preserving contracts. No such decision is assumed here. Any approved
requirement change must update the issue, documentation and acceptance assertions transparently before
rerunning them. A version bump, a ready PR or passing functional CI does not authorize a tag/publication.

## Acceptance status

The reviewed Windows snapshot uses the fixed issue workload and pinned host; it is not a universal
speedup or provider-billing measurement. [Benchmark gates](benchmark-gates.md) define reproducible
commands, evidence provenance and current rerun status.

| Gate | Reviewed result |
| --- | --- |
| BM-01 | Fail: 5348 candidate bytes versus 8883 OPS 0.3.1 bytes (39.795% reduction); official read 5457 bytes (1.997%). Requested source alone is 4320 bytes. |
| BM-02 | Pass: five edits in one tool-bearing round and both stale-CAS controls rejected. |
| BM-03 | Fail: full actual provider order 660 tokens/3219 bytes, including Windows Bash and real jobs; target ≤400. Catalogue order 661 is a separate tokenizer boundary result. |
| BM-04 | Pass: PDF absent initially, available on the owning provider request after discovery, absent for a sibling, then executed. |
| BM-05 | Pass: credential-fenced reads and outside writes rejected without denied-path/content leakage; an ordinary permitted outside read is an explicit allowed control. |

The file/discovery-only 241-token measurement does not pass the full-default BM-03 gate. No schema
contract, requested source, threshold or workload was removed to claim success. A missing optional
Bash fixture blocks the full Windows measurement rather than reducing its denominator. The final
candidate needs fresh functional and benchmark evidence after all fixes; unresolved failures must
remain explicit until maintainers decide how to resolve them.

Use the [manual acceptance checklist](manual-validation.md). This candidate does not merge PRs,
publish binaries or enable a disabled release workflow.
