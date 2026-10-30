---
name: dsh-scope-audit
description: Audit whether local paths and HTTP targets stay inside an explicit root or host allowlist. Use before artifact analysis, external downloads, or maintenance cleanup when scope must be demonstrated without changing approvals.
---

# Scope audit

Use the read-only scope checker from the plugin root:

```powershell
node scripts/scope-audit.mjs `
  --allow-root "D:\workspace" `
  --path "D:\workspace\sample.apk" `
  --allow-host "example.com" `
  --url "https://api.example.com/data"
```

Repeat `--path`, `--url`, `--allow-root`, and `--allow-host` as needed. The
checker returns one JSON record per target with an allow or denial reason.

- Paths are resolved through the nearest existing parent. Symlink escapes
  outside allowed roots fail.
- Credential directories and common private-key or credential-store names
  always fail.
- URLs with embedded userinfo, non-HTTP schemes, or hosts outside the allowlist
  fail.
- An empty host allowlist denies every URL.

This is an audit, not an approval mechanism. A denial blocks no other tool and
an allow result does not authorize an external side effect. Codex approvals
remain authoritative.
