---
name: dsh-safe-edit
description: Use for revision-checked file edits, literal multi-file replacement, or recovery from changed-file conflicts when PowerShell or direct writes would bypass the current SHA-256 revision. Applies to precise source edits and dry-run previews; not bulk generated rewrites without explicit scope.
---

# Dsh Safe Edit

Use the current file revision and a dry run before any mutation.

## One-file edit

Call `stat` and retain `revision`. Then preview a precise `edit_file`:

```json
{"path":"D:/project/src/file.ts","expectedRevision":"<sha256>","edits":[{"oldText":"exact unique old text","newText":"replacement"}],"dryRun":true}
```

Check that the preview target and change count are correct. Repeat with the same
`expectedRevision` and `dryRun:false` only after the preview is right. Each
`oldText` must occur exactly once.

On `EDIT_CONFLICT`, call `stat` again, rebuild the edit against current content,
and preview it. Never retry with a stale revision or blindly overwrite the file.

## Literal replacement

Use `replace` only for deliberate literal replacement, never regex work:

```json
{"path":"D:/project/src","pattern":"old literal","replacement":"new literal","glob":["**/*.ts","!**/generated/**"],"maxReplacements":20,"dryRun":true}
```

Review the returned file and replacement counts before applying. Keep the same
pattern, replacement and glob, set `dryRun:false`, and use a bounded
`maxReplacements`. If the intended set is larger, split it by directory or file.

## Verification contract

After writing, call `stat` for the new revision and use `dsh-text-search` for a
small verification window. Report:

```text
path: <file or root>
changed: <count>
revision: <new revision>
verified: <short evidence>
next: <none or one required action>
```

Do not print a full diff, unchanged file contents, or directory-wide logs.
`effectState` unknown or an interrupted call means inspect before any retry.
