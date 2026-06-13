# Constitution — Codex Plugin Durability & Safety

**Feature:** 001-codex-durability-safety · **Version:** 1.0.0 · **Base commit:** `807e03a`

Non-negotiable principles governing this feature. Every spec, plan, and task derives
from these; a change that violates one requires amending this document first.

## P1 — Filesystem only, no new dependencies
State stays on the filesystem using Node built-ins (`node:fs`, `node:os`,
`node:path`, `node:crypto`, `node:child_process`). No database, no broker for state,
no npm lock library. `package.json` runtime deps stay empty. *(PRD N1, NFR1)*

## P2 — Backward compatible, no migration
`state.json` files written by the current code load unchanged. No schema field is
added, removed, or renamed. Lock/`*.corrupt-*`/`*.tmp-*` artifacts are siblings the
job readers ignore. *(PRD N2, NFR4)*

## P3 — TDD throughout
Every behavioral change lands as a failing test first, then the minimal code to pass.
No production change merges without a test that fails before it and passes after.
*(PLAN method; dev rule: "Always TDD")*

## P4 — Reads never lock
`/codex:status`, `listJobs`, `getConfig`, and the gate's state reads stay lock-free
and side-effect-free. Only mutations take the lock; only locked reads may quarantine
a corrupt file. *(PRD NFR2; review R5)*

## P5 — Correctness rests on reclaim, not on graceful release
The lock must self-heal after SIGKILL/OOM via TTL + liveness reclaim. The
`process.on('exit')` release is best-effort only and must never be the sole recovery
path. *(review R4, R7; FR2, FR9)*

## P6 — Fail-safe over fail-open
The Stop-gate fails **closed** on any genuine failure (empty / timeout / non-zero
exit / invalid JSON). It may fail **open** only for a review that demonstrably ran and
produced non-empty, parseable-but-oddly-formatted output. Every block reason carries a
runnable bypass. *(PRD FR6; review R6)*

## P7 — Only signal what we own
No code path signals a process not owned by the current uid, or matched only by a
substring of its command line. Tracked-PID teardown is primary; the basename/marker/
uid predicate is a backstop. *(PRD FR5; finding F3)*

## P8 — Scope honesty
Guarantees are claimed only where they hold. Networked filesystems (NFS/SMB) and the
WSL2 DrvFs `/mnt/*` mount are best-effort and documented, never claimed-correct.
*(PRD NFR6, N5; review R11)*

## Amendment process
Amending a principle requires: (1) updating this file with a new patch version, (2)
recording the rationale in the spec's Decisions log, (3) updating any dependent FR in
`docs/PRD.md`.
