# Compact Native file ranges

中文：[紧凑文件范围](紧凑文件范围.md).

A fully returned `ops_read_many` range uses one path header, exact numbered text and one revision/continuation notice per file. When all files have exactly the same absolute parent, a JSON-quoted `Base` appears once and each JSON-quoted filename is relative to it. Different parents retain absolute paths.

```text
[Base: "/workspace/src"]
=== FILE: "server.ts" (Lines 1-2 of 80) ===
1|import { createServer } from 'http';
2|const port = 8080;
[Notice: revision=cfd1bc81432fd6b88748b827f46bb4242db17cf8655cf4ea90f3ba0e62065355; more lines; nextOffset=3.]
```

The characters after `N|` are the source line, including leading spaces. Control characters and Unicode line separators are escaped so source text cannot forge extra numbered rows or file headers. LF/CRLF accounting remains the worker's physical-line accounting.

“More lines” means the file has not been exhausted; use the stated `nextOffset`. “End of file; complete=true” means this range reached the end. The aggregate “requested ranges returned” receipt means every requested range body was returned, not that every whole file was read. Full revisions, total line counts and per-file continuation remain visible. Byte sizes and duplicate counters remain available in canonical/PTC data.

Physical clipping, missing files, unexpected coverage, stored references and other uncertain results retain the diagnostic renderer and explicit recovery notices. Final display clipping removes the successful aggregate claim and asks for the original range with a smaller limit. Deduplication recognizes both `N|` and the existing single-file `N | ` format; only an exact prior body in current provider context permits an unchanged-reference receipt.
