# Implementation Plan — Codex Plugin Durability & Safety

**Status:** Draft for review · **Base commit:** `807e03a` · **Related:** [`PRD.md`](./PRD.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md)

Method: **TDD throughout** — each task writes a failing test first, then the
minimal change to pass. Sequencing respects dependencies; phases are independently
shippable.

---

## Workstreams → phases

| WS | Theme | Findings | Phases |
|----|-------|----------|--------|
| A | Durability Core | F1, F2, F6 | P1, P2 |
| B | Process Safety | F3, F5 | P3 |
| C | Gate UX | F4 | P4 |
| D | Quality / Config | F7 | P5 |

Recommended order: **P1 → P2 → P3 → P4 → P5**. P1 and P2 share `lib/state.mjs`;
do P1 first because atomic writes are simpler to reason about once writes are
serialized. P3/P4/P5 are independent and can be parallelized after P2.

---

## Phase 1 — Cross-process state lock (F1) · HIGH

**Goal:** serialize all `state.json` mutations; re-read inside the lock.

Tasks:
1. **Test (red):** `tests/state.test.mjs` — spawn N≥20 child processes each calling
   `upsertJob` with a distinct id; assert the final state contains all N. Fails today.
2. **Test (red):** stale-lock reclaim — create `.state.lock/owner.json` with a dead
   PID and old `startedAt`; assert the next mutator reclaims and succeeds within TTL.
3. **Impl:** add `acquireStateLock` / `releaseStateLock` / `reclaimIfStale` /
   `isAlive` / `sleepSync` (Atomics.wait) to `lib/state.mjs` (ARCH §3).
4. **Impl:** add `withStateLock`; route `updateState` and public `saveState`
   through it; move the `previousJobs` re-read inside the locked section.
5. **Wire:** confirm `setConfig`, `upsertJob`, and `session-lifecycle-hook.mjs`
   `saveState` all flow through the locked path (no direct writes remain).
6. **Green + refactor.** Add `process.on('exit')` best-effort release.

Exit criteria: M1 passes; existing suite green; no direct `writeFileSync` to
`state.json` outside `saveStateLocked`.

## Phase 2 — Atomic writes + non-destructive recovery (F2) · HIGH

**Goal:** crash-safe writes; corrupt state is quarantined, not wiped.

Tasks:
1. **Test (red):** atomic write — monkeypatch/inject a failure between temp-write
   and rename; assert the prior `state.json` still parses (M3).
2. **Test (red):** corrupt recovery — write `{` into `state.json`; call `loadState`;
   assert (a) a `state.json.corrupt-*` backup exists, (b) a warning is emitted,
   (c) the returned state is the default (M2).
3. **Impl:** `atomicWriteFileSync` (tmp → fsync → `renameOver`) in `lib/state.mjs`
   (ARCH §4); apply at `state.mjs:114`, `state.mjs:169`, `broker-lifecycle.mjs:92`.
4. **Impl:** corrupt-quarantine branch in `loadState` (ARCH §5).
5. **Impl:** `renameOver` platform branch (ARCH §7).
6. **Green + refactor.**

Exit criteria: M2 + M3 pass; suite green; Windows `renameOver` unit-tested with a
mocked `fs`.

## Phase 3 — Process safety (F3, F5) · MED / LOW

**Goal:** never signal an unrelated or non-owned process; EPERM never throws.

Tasks:
1. **Test (red):** `tests/process.test.mjs` — a fake process whose argv contains
   `codex` as a substring but whose basename/owner does not match is **not**
   selected (M4). Use a pure matcher function so it is unit-testable.
2. **Test (red):** `terminateProcessTree` with an injected `killImpl` that throws
   `EPERM` returns `{ delivered:false, reason:'permission' }`, not a throw.
3. **Impl:** extract a `isOwnedCodexProcess({argv0, argv1, uid, env, trackedPids})`
   predicate; apply the basename/marker/uid rules (ARCH §6.1).
4. **Impl:** EPERM guard in both kill branches of `lib/process.mjs` (ARCH §6.2).
5. **Doc:** update the `/codex:init` cleanup block (PAI `init.md`) to use the
   precise predicate and the `uid == self` guard; reference this design (OQ3).

Exit criteria: M4 passes; cancel/SessionEnd never throw on a privileged PID.

## Phase 4 — Stop-gate UX (F4) · MED

**Goal:** completed-but-odd reviews don't trap the session; bypass is discoverable.

Tasks:
1. **Test (red):** `parseStopReviewOutput` with non-empty unrecognized text →
   `{ ok:true, warn:... }`; empty/timeout/non-zero still `{ ok:false }` (M5).
2. **Test (red):** every block reason string contains a runnable bypass command.
3. **Impl:** adjust the default branch in `parseStopReviewOutput`
   (`stop-review-gate-hook.mjs:91`); thread an optional `warn` to stderr.
4. **Impl:** append the bypass sentence to each block reason (ARCH §8).
5. **Impl (opt):** start-of-review stderr note for the long synchronous block.

Exit criteria: M5 passes; manual check — odd output ends the session with a warning.

## Phase 5 — Effort knob reconciliation (F7) · LOW

**Goal:** `init.md` and the companion agree on effort. The knob already exists
(`codex-companion.mjs:69` — `none|minimal|low|medium|high|xhigh`); the bug is that
`init.md` promises `max` (not a valid token) and never forwards `--effort`.

Tasks:
1. In the PAI `init.md`, replace the `max` wording with `xhigh` (decide via OQ4).
2. Make init's launched commands pass the level, e.g.
   `/codex:adversarial-review --background --effort xhigh`, and have setup/init note
   the effective effort instead of claiming an unenforced one.
3. (Opt) add `--effort` to the `/codex:adversarial-review` and `/codex:review`
   `argument-hint` so the passthrough is discoverable; test in `tests/commands.test.mjs`.

Exit criteria: no doc promises an effort token the runtime rejects; init's
launched reviews run at the stated effort.

---

## Test plan summary

| Metric | Phase | Test file |
|--------|-------|-----------|
| M1 concurrent upsert, 0 lost | P1 | `tests/state.test.mjs` |
| M2 corrupt → quarantine+warn | P2 | `tests/state.test.mjs` |
| M3 crash mid-write → prior parses | P2 | `tests/state.test.mjs` |
| M4 substring-`codex` not killed | P3 | `tests/process.test.mjs` |
| M5 unparseable→allow; bypass in reason | P4 | `tests/stop-gate.test.mjs` (new) |
| M6 no regression | all | `npm test` + CI |

## Rollout & verification

1. Land P1+P2 behind no flag (pure internal hardening; NFR4 backward compatible).
2. `npm test` + `npm run build` green locally and in `pull-request-ci.yml`.
3. Dogfood: run a `--background` review, force-kill mid-write, reopen, confirm
   `/codex:status` still lists the job and no orphan PID leaks.
4. Adversarial self-review (`/codex:review`) on the diff before opening the PR —
   the gate we already enabled this session covers it.

## Estimated effort

| Phase | Code | Tests | Risk |
|-------|------|-------|------|
| P1 | ~80 LOC in `state.mjs` | 2 multi-process tests | med (lock correctness) |
| P2 | ~40 LOC in `state.mjs` | 2 tests | low |
| P3 | ~30 LOC `process.mjs` + init.md | 2 tests | low |
| P4 | ~20 LOC hook | 2 tests | low |
| P5 | ~25 LOC or doc-only | 1 test | low |

Total: ~1 focused PR for A (P1+P2), then small follow-ups for B/C/D — or one
stacked series. No new dependencies, no schema migration.

## Acceptance criteria (pack-level)

- [ ] All of M1–M6 pass.
- [ ] No new runtime dependency added (`package.json` unchanged except scripts/tests).
- [ ] `state.json` files written by the old code still load unchanged.
- [ ] A simulated crash never produces an empty job list without a `*.corrupt-*` backup.
- [ ] No code path signals a process not owned by the current user.
- [ ] The stop-gate's block reasons each contain a runnable bypass command.
