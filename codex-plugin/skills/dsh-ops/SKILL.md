---
name: dsh-ops
description: Use the Codex dsh-ops native worker for bounded local file inspection, globbing, ripgrep-style search, revision-checked edits, file operations, CSV/TSV, DOCX, and restricted PDF text reads.
---

# dsh-ops native tools

The plugin exposes the `dsh-ops@0.4.1` native Rust worker through MCP. Each
call starts one bounded worker process. The worker never executes model code.

## Tool selection

Use `glob` for large path inventories with exclusions, sorting, and paging.

Use `grep` for Rust-regex search with file filters, counts, summaries, context,
and explicit scan-completeness facts.

Use `inspect_local_file` for bounded UTF-8 line ranges or hex views.

Use `read_files` for up to 32 independent file ranges in one call.

Use `replace` for deliberate literal replacement across files. Run it with
`dryRun: true` first when the match set is uncertain.

Use `edit_file` for one precise UTF-8 file edit set. Every `oldText` must occur
exactly once and `expectedRevision` is required.

Use `stat` before `write_file`, `edit_file`, `copy`, `move`, or `remove`.
These mutations require the current SHA-256 revision. Missing revision means
create-only for `write_file`; it is not an overwrite wildcard.

Use `read_table` for CSV/TSV lexical cells, `read_docx` for DOCX main-body
paragraphs, and `read_pdf` for the restricted PDF text-layer subset.

Use `result` only to page or release a `ref://` reference returned by an
earlier call. Native MCP runs without trusted result storage, so ordinary
bounded output is returned inline and no new reference is normally created.

## Operating rules

- Pass absolute local filesystem paths. Convert `file://` references to local
  absolute paths first.
- The worker refuses credential stores and private-key paths. Do not attempt
  to bypass that fence.
- Treat `status: "error"` or `status: "rejected"` as a structured failure, not
  as a successful empty result.
- Check `scanComplete`, `pageComplete`, `truncated`, `nextOffset`, and
  `continuation`. Narrow an incomplete search instead of assuming zero
  results.
- Check `effectState` before retrying a mutation. Never blindly repeat a
  mutation after a transport or cancellation error.
- Compare `revision` values when combining pages from repeated reads.
- Prefer Codex's normal patch tool for a small exact edit when no revision
  workflow is needed. Use dsh-ops when its bounded read or revision-checked
  mutation adds value.

## Documents

The document readers are intentionally narrow.

- `read_table`: CSV/TSV only, no spreadsheet formulas or type coercion.
- `read_docx`: main-body paragraphs only, not rendered layout or headers.
- `read_pdf`: classic-xref PDFs and a restricted standard-font text layer,
  with no OCR, images, forms, or arbitrary embedded fonts.

Report an unsupported-document error as a scope limit. Do not silently replace
it with an unverified text extraction.
