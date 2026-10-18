# Result budgets and session lifetime

OPS worker calls have a 30-second execution ceiling. Native and PTC share a FIFO admission lane
per host session: two active calls and eight waiting calls. Overflow returns CALL_LIMIT with no
effects. A cancelled queued call never starts. Authority is resolved again after admission.
Native model text remains capped at 64 KiB after escaping; worker transport has a separate
128 KiB collection limit. Canonical result storage has its own 10 MiB/result and 100 MiB/session
limits. Transport, model text and stored data are separate budgets.

Reference storage uses a private temporary cache selected by trusted host metadata. Windows uses
the actual sandbox provider's session temp directory and private-temp write capability. PTC still
runs through host confinement; Native fixed file operations keep their policy-governed executor.
Full-access cache preparation voluntarily uses a narrower workspace-write policy. If a cache
cannot be prepared, file operations retain their bounded, explicit incomplete result; reference
creation reports unavailable storage. There is no unconfined PTC fallback.

Each reference binds the live session, current authority, credential fence, operation root and
producer tool. Only currently published/executable producers and the admitted tool are allowed.
Changing the permission mode invalidates the previous authority binding, including narrowing to
read-only. Read-only never creates a cache or updates LRU state. Existing direct legacy audit
references retain their separate contract.

Session disposal immediately expires references, cancels queued/running work, awaits settlement,
then purges validated snapshot/staging blobs through the current host authority. The stable lock
and unknown names remain; audit data is never purged. Read-only mode or unavailable host services
can defer physical cleanup, with a diagnostic. A fresh in-memory session nonce prevents reopening
disk leftovers as valid references after a restart. Component owners share this lifetime; unloading
the last Native/PTC owner expires its remaining sessions. Cleanup is an internal operation and
cannot be requested through model tool arguments.
