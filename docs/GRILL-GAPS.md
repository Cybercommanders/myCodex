# Grill Gaps — Codex Plugin Durability & Safety

Auto-grill of the v0.2 pack against the actual codebase. Each gap is something the
implementer should decide or watch, surfaced by stress-testing the spec against
`plugins/codex/scripts/**`. Severity: 🔴 must-resolve-before-merge · 🟡 decide-in-phase
· ⚪ note.

---

## G1 🟡 — `loadState` signature change ripples to every caller
The recovery design adds `loadState(cwd, { locked })`. `loadState` is called from
`state.mjs` (`saveState:93`, `updateState:119`, `listJobs:150`, `getConfig:163`),
`session-lifecycle-hook.mjs:52`, and indirectly via `listJobs`/`getConfig` in the gate
hook. **Gap:** the default must be `locked:false` so existing callers stay
side-effect-free; only `updateState`'s internal read passes `locked:true`. Confirm no
caller relies on `loadState` to repair a corrupt file *outside* a mutation. (Spec B3
already mandates this; flagged so it isn't missed in T2.7.)

## G2 🟡 — `MAX_JOBS` prune + lock interaction
`saveState` prunes to 50 and deletes dropped job files (`state.mjs:105-112`). Under the
lock this is now serialized, good — but the prune deletes `job.logFile` and the job
json for any id not retained. **Gap:** if two sessions' jobs interleave near the cap,
the locked re-read means the loser's pruning decision is recomputed correctly, but
confirm the N≥20 concurrency test (T1.1) uses **distinct** ids under the cap so it
tests the lock, not the prune. (Test-strategy already says distinct ids; keep N under
50 or assert prune-aware.)

## G3 🟡 — SessionEnd ordering vs. broker shutdown
`handleSessionEnd` calls `cleanupSessionJobs` *then* `teardownBrokerSession`
(`session-lifecycle-hook.mjs:102-111`). Rewriting `cleanupSessionJobs` to take the
state lock (R2/T1.8) adds a lock acquire during shutdown. **Gap:** if a background job
is mid-write when the session ends, SessionEnd now *waits* up to `LOCK_WAIT_MS` (10s).
Acceptable, but the try/catch must ensure a lock-busy timeout **logs and proceeds**
with broker teardown rather than throwing out of `handleSessionEnd` (which calls
`process.exit(1)` on throw, `:128-131`). Decision: lock failure in cleanup = warn +
continue, never exit non-zero.

## G4 🔴 — `withStateLock` reentrancy
`updateState` takes the lock and calls `saveStateLocked`. If any mutator accidentally
calls a *public* (lock-taking) function while already holding the lock, the second
`mkdirSync` sees its own lock as `EEXIST` and **deadlocks until TTL/timeout**.
**Gap/decision:** the directory `mkdir` lock is **not reentrant**. Audit that no locked
section calls public `saveState`/`upsertJob`/`setConfig`. `saveStateLocked` and the
`locked:true` read are the only things allowed inside `withStateLock`. Add an assertion
or a thread-local "held" guard in dev/test. (This is the single most likely
self-inflicted bug; it earns 🔴.)

## G5 🟡 — Owner `startedAt` ≠ process start time
The reclaim staleness uses `owner.json.startedAt`, which is when the **lock** was
acquired, not when the **process** started. For PID-reuse (R7), a recycled PID with a
*newer* real process whose lock `startedAt` is old will be `age > TTL` and reclaimed —
correct. But a long-running legitimate holder that holds >30s (`LOCK_TTL_MS`) while
genuinely alive would be wrongly reclaimed **if** `isAlive` ever returns false
transiently. **Gap:** TTL only triggers reclaim when the owner is *also* not alive
(`ownerAlive = sameHost && pidLive && age ≤ TTL`) — re-read ARCH §3.2: a live same-host
owner is never reclaimed regardless of age. Confirm the boolean is `AND`, not `OR`, in
impl (T1.5). A long mutation (>30s) is implausible here (writes are tiny), but the
invariant must hold.

## G6 🟡 — `fsyncDir` on the state dir vs. the jobs dir
Atomic writes target three locations: `state.json` (in `<stateDir>`), job json (in
`<stateDir>/jobs`), broker session (in its own dir). **Gap:** `fsyncDir` must fsync the
*directory that contains the renamed file* — for job files that's `jobs/`, not
`<stateDir>`. Trivial but easy to get wrong; the contract says `dirname(target)`, keep
it.

## G7 ⚪ — Atomics.wait fallback under `--test`
`node --test` runs the suite in-process; `SharedArrayBuffer` is available there. The
fallback path (R8) will rarely execute in CI. **Gap:** add an explicit unit test that
forces the fallback (e.g. temporarily shadow `globalThis.SharedArrayBuffer`) so the
fallback isn't dead/untested code.

## G8 ⚪ — `*.corrupt-*` / `*.tmp-*` accumulation
Recovery and atomic-write leave `state.json.corrupt-<ts>` and (on crash) orphan
`.state.json.tmp-*` files. **Gap:** nothing cleans them. The 50-job prune doesn't touch
them. Acceptable (they're diagnostic and small), but note for a future
`/codex:status --recover` or a startup sweep. Out of scope for this feature (PRD §9),
recorded so it isn't a surprise.

## G9 ⚪ — Windows `kill(pid,0)` / `getuid` absence
`isOwnedCodexProcess` uses `process.getuid?.()` — **undefined on Windows**. On Windows
both sides of `uid === process.getuid?.()` are `undefined`, so `undefined === undefined`
→ true, which *disables* the uid guard on Windows. **Gap/decision:** acceptable
(Windows lacks uid semantics and already branches to `taskkill`), but the basename/
marker/tracked-PID checks must carry the safety alone there. Document it.

## G10 🟡 — No test asserts the *whole* SessionEnd path under concurrency
T1.1 tests `upsertJob` fan-out; R2 is specifically the SessionEnd `load→filter→save`
race. **Gap:** add a test where a child flips a job to `completed` while the parent runs
the rewritten `cleanupSessionJobs`, asserting the completion isn't dropped (the exact
F1-on-shutdown scenario). Currently only implied by T1.8; make it an explicit red test.

---

## Residual open questions (none blocking)
- **OQ-A:** Should `LOCK_WAIT_MS` (10s) be lower for the SessionEnd path to avoid a
  10s shutdown stall on a wedged lock? (Lean: yes — pass a shorter budget from the
  hook, e.g. 2s, then warn+proceed. G3.)
- **OQ-B:** Should a startup sweep delete `*.corrupt-*` older than N days? (Defer; G8.)
- **OQ-C:** `LOCK_TTL_MS=30s` vs. the 15-min stop-review block — a stop-review holds no
  state lock (it only reads), so the TTL is unaffected. Confirmed safe; noted for the
  reviewer who might worry the long gate run could be seen as a stale lock (it can't —
  the gate doesn't lock).

## Verdict
The pack is internally consistent and grounded in the real code. **G4 (reentrancy)** is
the one item that must be explicitly guarded in implementation; **G3** and **G10** are
real test/behavior gaps to close in Phase 1; the rest are decide-in-phase or notes. No
finding contradicts the spec — they sharpen its implementation.
