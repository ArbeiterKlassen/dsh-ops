---
name: dsh-bounded-read
description: Use for bounded text, JSON, CSV, DOCX, or PDF inspection when PowerShell would otherwise use Get-Content -Raw, cat, ConvertFrom-Json with a full dump, or similar whole-file reads. Applies to configuration, logs, data files, and document excerpts.
---

# Dsh Bounded Read

Read only the slice that answers the next decision. Call `stat` first when line
count or file type is unknown.

## Text and logs

Read at most two files and 120 lines per call:

```json
{"files":[{"path":"D:/project/log.txt","offset":1,"limit":80}]}
```

For a tail, use `stat.lineCount`, then request the last 60 lines by offset.
`inspect_local_file` is the one-file alternative and should stay at or below 80
lines.

Never use `Get-Content -Raw`, `cat`, `type`, `ReadAllText`, or an unfiltered
`Get-Content` for diagnosis.

## JSON

Start with a root summary:

```json
{"path":"D:/data/CommonEvents.json","maxChars":4000}
```

Then select one path and project fields:

```json
{"path":"D:/data/CommonEvents.json","selector":"[1522].list","where":{"code":117},"fields":["code","indent","parameters"],"context":1,"limit":20,"maxChars":12000}
```

Do not line-read JSON above 64 KiB. Do not parse and print the complete document
through PowerShell or Python.

## Tables and documents

Use `read_table` for CSV/TSV with at most 50 rows, `read_docx` for at most 20
main-body paragraphs, and `read_pdf` for at most five text-layer pages. Page
again only when the returned rows or pages are actually needed.

## Output contract

Return offsets, line or page ranges, truncation facts, and at most 12,000
characters of selected content. Do not replay the read in a second formatting
command.
