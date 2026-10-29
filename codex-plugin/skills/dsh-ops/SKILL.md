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

Use `json_query` for any large or minified JSON file. It accepts:

- `path`: JSON file.
- `selector`: property/index path such as `[1522].list` or `events[196].pages[0].list`.
- `where`: equality filter for array objects, e.g. `{"code":401}`.
- `contains`: substring filter over compact item JSON.
- `fields`: optional field projection.
- `offset`, `limit`, `context`, `maxChars`: bounded paging/window/output.

Examples:

```json
{"path":"D:/game/www/data/CommonEvents.json","selector":"[1522].list","where":{"code":117},"context":2,"limit":10}
{"path":"D:/game/www/data/Map178.json","selector":"events[196]","fields":["id","name","x","y","pages"],"maxChars":12000}
```

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
- **Do not use `read_files` or `inspect_local_file` to read a minified JSON
  file larger than 64 KiB.** Their line-oriented output can otherwise place the
  entire file in model context. Use `json_query`; if the needed contract cannot
  be expressed with selector/where/fields, narrow the request instead of
  dumping the file.
- **Do not use PowerShell/Python to dump large JSON for diagnosis.** Scripts may
  parse JSON to perform a write, but exploration must go through `json_query`.
- Start with a root summary (omit `selector`), then select one object/array and
  request at most 50 items. Prefer `fields` and `context` over full objects.
- Compare `revision` values when combining pages from repeated reads.
- Prefer Codex's normal patch tool for a small exact edit when no revision
  workflow is needed. Use dsh-ops when its bounded read or revision-checked
  mutation adds value.

## Documents

The document readers are intentionally narrow.

- `read_table`: CSV/TSV only, no spreadsheet formulas or type coercion.
- `read_docx`: main-body paragraphs only, not rendered layout or headers.
- `read_pdf`: classic xref, xref streams, object streams and incremental
  `Prev` chains, with a restricted standard-font text layer. It provides no
  OCR, images, forms, or arbitrary embedded fonts.

Report an unsupported-document error as a scope limit. Do not silently replace
it with an unverified text extraction.
