---
name: dsh-text-search
description: Use for bounded repository or file text search when PowerShell would otherwise use rg, Select-String, or broad piped search output. Applies to symbol lookup, error-string searches, caller discovery, and changed-file checks.
---

# Dsh Text Search

Use the worker's `grep` instead of `rg` or `Select-String` for exploratory
search. Escalate from counts to locations, then to the smallest content window.

## Search sequence

Start with an aggregate:

```json
{"path":"D:/project","pattern":"functionName","glob":["src/**/*.ts"],"outputMode":"summary","caseInsensitive":false,"limit":10}
```

Find files when the count matters:

```json
{"path":"D:/project","pattern":"error_code","glob":["src/**/*.ts"],"outputMode":"files_with_matches","limit":40}
```

Read content only after reducing the file set. Keep content to 20 hits and zero
or one context line:

```json
{"path":"D:/project","pattern":"targetSymbol","glob":["src/auth/**/*.ts"],"outputMode":"content","lineNumbers":true,"beforeContext":1,"afterContext":1,"limit":20}
```

Use `outputMode:"count"` when ranking files by hit count. Use
`caseInsensitive:true` explicitly rather than changing the pattern around case.

## Output budget

Treat a content page above 12,000 characters as too large. Reduce the glob first,
then `limit`, then context. Never follow a search with a full-file read unless
the hit line itself is insufficient.

Report `matchedObserved`, `matchedTotal`, `scannedFiles`, `skippedFiles`,
`scanComplete`, `pageComplete`, `truncatedBy`, and `nextOffset`. If the scan is
incomplete, state that the result is a lower bound and narrow the search.
