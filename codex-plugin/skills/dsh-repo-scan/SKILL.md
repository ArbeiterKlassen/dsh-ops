---
name: dsh-repo-scan
description: Use for compact repository inventory, path validation, file metadata, hashes, and changed-file triage when PowerShell would otherwise use Get-ChildItem, Get-Item, Test-Path, Get-FileHash, or broad git status output. Do not use for content search or reading file bodies.
---

# Dsh Repo Scan

Produce a small factual map before opening content.

## Discovery recipe

For a known path, call `stat` first. It returns existence, SHA-256 revision,
bytes, line count, timestamps, and permissions without content.

For a repository tree, use `glob`:

```json
{"path":"D:/project","pattern":["**/*"],"outputMode":"paths","sort":"path","limit":80}
```

Use exclusions and narrower roots before increasing `limit`:

```json
{"path":"D:/project","pattern":["src/**/*.ts","tests/**/*.ts","!**/generated/**"],"outputMode":"paths","sort":"path","limit":100}
```

Use `outputMode:"details"` only when size or modification time decides the next
step. Keep details pages at 30 rows.

## Git triage

The worker does not execute Git. When repository state is required, prefer:

```powershell
git status --short --branch
git diff --stat
```

Run these with `max_output_tokens` at or below 1500. Scope `git diff --stat`
to the files under review when the repository is large.

Then inspect only named paths with `stat`, `diff`, or `dsh-bounded-read`.
Do not begin with an unfiltered `git diff` or recurse through the whole
repository.

## Output contract

Return at most 80 paths, or 30 detailed rows. Report counts, changed paths,
sizes, hashes, and truncation facts. Omit unchanged directories and full file
contents.

If `scanComplete` or `pageComplete` is false, use `nextOffset` or narrow the
query. Do not retry with a larger page.
