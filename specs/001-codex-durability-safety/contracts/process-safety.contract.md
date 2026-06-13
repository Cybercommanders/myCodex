# Contract — Process Safety (`lib/process.mjs`)

Covers FR5, FR7. Verified by M4.

## `isOwnedCodexProcess({ argv0, argv1, uid, env, trackedPids, pid }) → boolean`
Pure predicate (no I/O), unit-testable.
- `trackedPids.includes(pid)` → return `uid === self`.
- `uid !== self` → `false` (never signal another user — spares root `earlyoom`, F3).
- `basename(argv0) ∈ {"codex","codex-companion"}` → `true`.
- `basename(argv0)==="node"` AND `argv1` ends with `codex-companion.mjs` → `true`.
- `env.CODEX_COMPANION_SESSION_ID` present → `true`.
- Otherwise → `false`. A bare argv substring `codex` is **never** a match.

## `terminateProcessTree(pid, options) → { attempted, delivered, method, reason? }`
- Non-finite pid → `{attempted:false, delivered:false, method:null}`.
- Windows → `taskkill /PID <pid> /T /F`; missing-process text → `delivered:false`;
  `ENOENT` → fall back to `kill`.
- POSIX → `kill(-pid,'SIGTERM')` (group); on failure, `kill(pid,'SIGTERM')` (single).
- **FR7:** `EPERM` **or** `ESRCH` in **either** branch →
  `{attempted:true, delivered:false, method, reason: EPERM?'permission':'not-found'}`.
  Never throws on these. Any other error rethrows.
- **Guarantee:** `/codex:cancel` and the SessionEnd hook never crash on a privileged or
  reparented PID.
