# Advanced tools on demand

中文：[工具发现](工具发现.md).

`dsh-ops/discovery` publishes `ops_discover` in each eligible Native scope. Describe a capability (`metadata revision hash`) or select an exact public name (`select:ops_stat`). Discovery only chooses tools; it performs no file action. A successful selection remains pending through the current tool round. Its owning session's committed `step/end` publishes it for the next provider request. The pinned host assembles before `agent/pre-step`; queued publication is therefore drained and the public prompt service reassembles a stale snapshot. Diagnostic assemblies before that committed boundary cannot activate pending names. Newly published tools remain scoped to their owner; parents, children and siblings must discover independently.

The component is exported now. The seven-row bundle installation and 0.3 profile migration are a separate release slice. A manually added row can use:

```yaml
- name: dsh-ops/discovery
  config:
    enabled: true
    maxResults: 3
    allowedTools: [read_many, edit_many, result, glob, grep, replace, write_file, edit_file, diff, stat, copy, move, remove]
    alwaysLoaded: []
```

| Setting | Default | Contract |
| --- | --- | --- |
| `enabled` | `true` | Publish the discovery entry. `false` preserves `alwaysLoaded` tools. Disabling the entire loader row unloads all its owned tools. |
| `maxResults` | `3` | Maximum selections per call, integer 1-5. A call's optional `max_results` is also validated as 1-5 and capped by this setting. |
| `allowedTools` | All implemented advanced names above | Allowed pool of raw capability names. Unknown/unimplemented formats are rejected, rather than advertised as usable. |
| `alwaysLoaded` | `[]` | Choices from the allowed pool that bypass discovery and are available at the first eligible step. |
| `binaryPath` / `required` | Automatic / `false` | Worker selection and activation failure behavior, as for native file tools. |
| `denyCredentialReads` | `true` | Preserve the native file credential fence. |

Configuration arrays are copied and deduplicated; unknown configuration keys are errors naming the key. Search is a deterministic keyword match over reviewed metadata, with stable tie ordering; it does not call a model. `query` is nonempty and at most 512 characters; extra action arguments are rejected. PDF, Word and table readers cannot be discovered until implementations pass their own acceptance review. The current catalogue does not pretend those formats are ready.

Every activated file tool keeps its declared path base, argument schema, Native rendering, worker permission checks and revision/CAS contract. Read-only scopes cannot activate mutation tools. A sandbox-mode change clears that session's pending requests, cancels its active calls and re-evaluates registrations; other sessions retain their choices. Disposing an agent or unloading the component removes registrations and invalidates cached definitions. Pure PTC scopes do not publish this Native discovery surface; the PTC adapter owns its SDK.

Only this plugin's scoped `ctx.tools.register`, `restrict`, prompt sections and lifecycle listeners are used. No host method or shared tool registry is replaced. Publication compares the desired tool names before changing registrations so it can coexist with PTC lifecycle listeners.

## Measurement boundaries

The deterministic entry measurement uses `js-tiktoken@1.0.21` with `cl100k_base`, encoding compact JSON of the pinned host `ToolSchema` fields (`name`, `description`, `parameters`). The discovery entry is **120 tokens / 552 UTF-8 bytes**. This is a reproducible schema measurement, not provider billing, and excludes tool-message framing, prompt guidance and other OPS components. The tokenizer is a test-only dependency published on 2025-08-09; its locked `base64-js` dependency is also test-only.

The unchanged fourteen-tool Native file surface plus discovery measures **3183 tokens / 14942 bytes** by the same method; this slice does not claim that whole surface passes 400. The next slice reduces the resident file set and records its own complete file/discovery baseline. Shell/PTC or operator always-loaded choices must be measured separately, not silently excluded from a global claim.

BM-04 runs through the real Cordis tool/prompt services and native worker: an implemented `stat` capability is absent before discovery, remains absent through current-step assembly, appears in the immediately following real AgentLoop provider request, and executes successfully. PDF is unimplemented, so this is the lifecycle gate, not a claim that PDF acceptance passed.

The browser configuration multi-select is separate work: plain configuration validation does not automatically generate a host selector. Its UI must use the pinned host's browser plugin configuration APIs.

Overlapping discovery rows use the nearest owning scope; the last row mounted in the same scope wins until it is unloaded. File rows may mount before or after discovery. Only exact OPS-owned Native registrations are yielded or masked; unrelated external registrations remain visible. PTC Native shadows retain their exact origin, and discovered activations cannot be inherited by another agent. Native `result` is page/release only and may be discovered in read-only mode; the worker still rejects forbidden release actions. `read_many` and `edit_many` retain their existing per-file completeness and CAS contracts.

BM-03 remains a full default Native-surface gate, including Windows Bash when integrated. The entry-only measurement above does not satisfy that gate.
