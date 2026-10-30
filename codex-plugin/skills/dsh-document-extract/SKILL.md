---
name: dsh-document-extract
description: Use for bounded extraction from CSV/TSV, DOCX main-body paragraphs, or text-layer PDFs when a full document or a shell conversion would flood the context. Covers headers, row/paragraph/page paging, and explicit extraction limits; not OCR, layout reconstruction, or formula evaluation.
---

# Dsh Document Extract

Confirm the path with `stat`, then extract one bounded unit at a time.

## CSV and TSV

Start with the header and at most 50 rows:

```json
{"path":"D:/data/table.csv","header":true,"offset":1,"limit":50}
```

Report the columns, rows observed, `rowCount` or `total` when available,
`scanComplete`, `pageComplete`, `nextOffset`, and the source revision. Read later
pages only when the current rows are insufficient.

## DOCX

Read at most 20 main-body paragraphs:

```json
{"path":"D:/docs/report.docx","offset":1,"limit":20}
```

Preserve paragraph and table coordinates. State that headers, footers, comments,
notes, rendered layout, and metadata are outside the returned scope.

## PDF

Read at most five text-layer pages:

```json
{"path":"D:/docs/report.pdf","offset":1,"limit":5}
```

The reader accepts classic xref tables, xref streams, object streams, and
incremental `Prev` chains. It does not provide OCR, images, forms, arbitrary
embedded fonts, or rendered reading order.

## Output contract

Return only the requested rows, paragraphs, or pages plus completeness and
revision facts. If the document is unsupported or incomplete, narrow the range
or report the extraction limit. Do not substitute an unchecked shell converter.
