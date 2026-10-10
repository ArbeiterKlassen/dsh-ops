---
name: dsh-ops
description: Use the Codex dsh-ops MCP server for fast local file inspection, globbing, ripgrep-style search, batch replacement, and optionally managed background jobs. Triggers when Codex should use FastCtx file tools or dsh-ops MCP tools instead of generic filesystem reads.
---

# dsh-ops FastCtx tools

Use the dsh-ops MCP server when it is available and the task is local file work.

The server usually exposes these tools:

- `glob` for paging large path inventories.
- `grep` for Rust-regex search with count, summary, and context modes.
- `inspect_local_file` for text ranges, encoding-aware reads, PDF text, and hex inspection.
- `replace` for deliberate batch edits with dry-run and replacement guards.

When shell tools are enabled, it can also expose `run`, `run_background`, `job_output`, `job_list`, and `job_kill`.

## Operating rules

- Pass plain absolute local filesystem paths. If a reference is URI-shaped, convert it to the equivalent local absolute path.
- Prefer `glob` and `grep` over ad hoc recursive shell commands when the server is connected.
- Inspect before editing. Use `replace` with `dry_run: true` for large or uncertain edits.
- Use Codex's normal edit tool for small, precise patches. Use `replace` when the same change must hit many files.
- Treat `replace` as a write action. Keep the target inside the current workspace unless the user asked for a broader path.
- Do not assume shell tools exist. They require `DSH_OPS_ENABLE_SHELL=1` and a usable bash executable.
- For background jobs, keep the returned `job_id` and use `job_output` before deciding that a job failed.
- If an MCP tool is unavailable, fall back to Codex's built-in file and shell tools.

## Tool selection

Use `inspect_local_file` for:

- Large files that should be read in ranges.
- Known non-UTF-8 encodings.
- PDF text extraction.
- Hex inspection of binary files.
- Batch reads of several files in one call.

Use `grep` for:

- File lists that match a pattern.
- Per-file match counts.
- Global summaries without dumping every match.
- Context around matching lines.

Use `glob` for:

- Large path inventories.
- Exclusion patterns.
- Modified-time sorting.

Use `replace` for:

- Repeated replacements across many files.
- Dry-run previews.
- Guarded writes with `max_replacements`.
