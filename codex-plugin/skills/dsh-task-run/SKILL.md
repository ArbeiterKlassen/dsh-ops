---
name: dsh-task-run
description: Use when running Node, Python, build, test, lint, or verification commands whose logs may flood the conversation. Standardizes exit-code capture, compact logs, failure extraction, and bounded follow-up reads.
---

# Dsh Task Run

The dsh-ops worker does not execute project commands. Use Codex
`exec_command` only for the command itself, then return to dsh-ops for bounded
inspection.

## Run contract

Set `max_output_tokens` to 2500 or less. Prefer test reporters that emit compact
progress. Keep one command per tool call when failures need attribution.

For a short verification run, capture only the tail:

```powershell
& <command> 2>&1 | Select-Object -Last 60
exit $LASTEXITCODE
```

When the full log is necessary, redirect it once to a unique file under the
workspace `_worktmp` directory or the system temp directory. Do not print the
log after writing it. Report its path and then:

1. use `grep` with `outputMode:"summary"` for errors and failures;
2. use `grep` with `outputMode:"content"` for at most 20 failure lines;
3. use `read_files` or `inspect_local_file` for at most 60 tail lines.

## Response format

Return:

```text
command: <single normalized command>
status: pass|fail|cancelled|timeout
exit: <integer or unavailable>
summary: <counts or first actionable error>
log: <path or inline>
next: <one action>
```

Do not paste full build output, dependency trees, package manifests, compiler
walls, or repeated stack traces. On a non-zero exit, inspect the first
actionable failure before retrying. Do not change tool recipes while a command
sequence is still being diagnosed.
