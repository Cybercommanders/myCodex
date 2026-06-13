# Implementation Plan — Codex Plugin Durability & Safety

**Feature:** 001-codex-durability-safety · **Base commit:** `807e03a`
**Method:** TDD throughout (P3). **Related:** [`spec.md`](./spec.md),
[`tasks.md`](./tasks.md), [`test-strategy.md`](./test-strategy.md).

Order: **P1 → P2 → P3 → P4 → P5.** P1+P2 share `lib/state.mjs`; P3/P4/P5 are
independent and parallelizable after P2.

| WS | Theme | Findings | Phase | Review hardening |
|----|-------|----------|-------|------------------|
| A | Durability Core | F1, F2, F6 | P1, P2 | R1, R2, R3, R4, R5, R7, R8, R9, R10 |
| B | Process Safety | F3, F5 | P3 | — |
| C | Gate UX | F4 | P4 | R6 |
| D | Quality / Config | F7 | P5 | R11 (docs) |

---

## Phase 1 — Cross-process state lock (F1) · HIGH
**Goal:** serialize all `state.json` mutations; re-read inside the lock; self-heal
after crash.

1. **Red:** `tests/state.test.mjs` — N≥20 child processes each `upsertJob` a distinct
   id; assert all N survive (M1). *Fails today.*
2. **Red:** stale-lock reclaim — seed `.state.lock/owner.json` with a dead PID + old
   `startedAt`; assert next mutator reclaims within TTL (M7).
3. **Red (R1):** two racing mutators against one stale lock → exactly one acquires.
4. **Red (R7):** owner.json with a live but wrong-host (or recycled-PID) descriptor →
   treated as stale.
5. **Impl:** `acquireStateLock`/`releaseStateLock`/`reclaimIfStale`/`isAlive`/
   `sleepSync` (with SAB feature-detect + fallback, R8) in `lib/state.mjs` (ARCH §3).
6. **Impl:** `withStateLock`; route `updateState` + public `saveState`; move
   `previousJobs` re-read inside the locked section.
7. **Impl (R2):** rewrite `cleanupSessionJobs` (`session-lifecycle-hook.mjs:52,70`) to
   one `updateState` locked RMW; wrap in try/catch so shutdown never blocks.
8. **Wire:** confirm `setConfig`, `upsertJob`, SessionEnd all flow through the locked
   path; no direct `writeFileSync` to `state.json` remains outside `saveStateLocked`.
9. **Green + refactor.** Best-effort `process.on('exit')` release (R4: not the only
   path).

Exit: M1 + M7 pass; suite green; no stray state writes.

## Phase 2 — Atomic writes + non-destructive recovery (F2) · HIGH
**Goal:** crash-safe, durable writes; corrupt state quarantined not wiped; no reader
race.

1. **Red:** atomic write — inject a failure between temp-write and rename; assert prior
   `state.json` still parses (M3); assert `fsyncDir` invoked (R3, via injected fs).
2. **Red:** corrupt recovery (locked) — write `{` into `state.json`; locked
   `loadState`; assert `*.corrupt-*` backup exists, warning emitted, default returned
   (M2).
3. **Red (R5):** corrupt file + unlocked `loadState` → default, **no** rename, no throw.
4. **Red (R9):** temp opened with `O_EXCL` — second open of same temp path fails.
5. **Impl:** `atomicWriteFileSync` (`O_EXCL` temp → fsync file → `renameOver` →
   `fsyncDir`) in `lib/state.mjs` (ARCH §4); apply at `state.mjs:114,169`,
   `broker-lifecycle.mjs:92`.
6. **Impl:** `loadState(cwd,{locked})` quarantine branch (ARCH §5, R5/R10 warning text).
7. **Impl:** `renameOver` platform branch + `fsyncDir` best-effort skip (ARCH §7).
8. **Green + refactor.**

Exit: M2 + M3 pass; suite green; Windows `renameOver` unit-tested with mocked `fs`.

## Phase 3 — Process safety (F3, F5) · MED/LOW
1. **Red:** pure `isOwnedCodexProcess` — argv-substring `codex` but wrong basename/uid
   → not selected (M4).
2. **Red:** `terminateProcessTree` with injected `killImpl` throwing `EPERM` in **each**
   branch → `{delivered:false, reason:'permission'}`, no throw.
3. **Impl:** `isOwnedCodexProcess` predicate (ARCH §6.1); EPERM guard in both kill
   branches (ARCH §6.2).
4. **Doc:** update PAI `init.md` cleanup to use the predicate + `uid==self` (OQ3).

Exit: M4 passes; cancel/SessionEnd never throw on a privileged PID.

## Phase 4 — Stop-gate UX (F4) · MED
1. **Red:** `parseStopReviewOutput` non-empty-odd → `{ok:true,warn}`; empty/timeout/
   non-zero/invalid-JSON → `{ok:false}` (M5, both directions, R6).
2. **Red:** every block reason contains a runnable bypass command.
3. **Impl:** narrow the default branch (`stop-review-gate-hook.mjs:91`); thread `warn`
   to stderr; append bypass sentence to each reason (ARCH §8).
4. **Impl (opt):** start-of-review stderr note for the 15-min block.

Exit: M5 passes; odd output ends the session with a warning; real failures still block.

## Phase 5 — Effort knob reconciliation (F7) · LOW
1. In PAI `init.md`, replace `max` with `xhigh` (`init.md:21-22,202-203`).
2. Pass `--effort xhigh` to init's launched commands; note effective effort.
3. (Opt) add `--effort` to `argument-hint` for `/codex:adversarial-review` +
   `/codex:review`; test in `tests/commands.test.mjs`.
4. **Doc (R11):** add the NFS/WSL2-DrvFs best-effort caveat to ARCHITECTURE §7 +
   adapter notes.

Exit: no doc promises a rejected effort token; init runs at the stated effort.

## Rollout & verification
1. Land P1+P2 behind no flag (pure internal hardening; NFR4).
2. `npm test` + `npm run build` green locally and in `pull-request-ci.yml`.
3. Dogfood: `--background` review, force-kill mid-write, reopen, confirm
   `/codex:status` still lists the job and no orphan PID leaks; confirm a SIGKILLed
   lock holder self-heals (R4).
4. Adversarial self-review (`/codex:review`) on the diff before the PR.

## Estimated effort
| Phase | Code | Tests | Risk |
|-------|------|-------|------|
| P1 | ~110 LOC `state.mjs` + hook rewrite | 4 multi-process tests | med (lock + reclaim correctness) |
| P2 | ~60 LOC `state.mjs` | 4 tests | low-med (dir-fsync, reader race) |
| P3 | ~35 LOC `process.mjs` + init.md | 2 tests | low |
| P4 | ~25 LOC hook | 2 tests | low |
| P5 | ~25 LOC / doc | 1 test | low |
