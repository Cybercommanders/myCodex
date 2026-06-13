# Tasks — Codex Plugin Durability & Safety

TDD order. `[ ]` = todo. Each test task is **red-first**. `→ M#` = metric verified.
Findings: F1–F7 (proposal), R1–R11 (review).

---

## Phase 1 — Cross-process state lock (HIGH · F1 · R1,R2,R4,R7,R8)
- [ ] T1.1 (red) `tests/state.test.mjs`: N≥20 parallel `upsertJob` children, assert 0 lost → M1
- [ ] T1.2 (red) stale-lock reclaim: dead PID + old `startedAt` reclaimed within TTL → M7
- [ ] T1.3 (red) reclaim TOCTOU: two racing mutators on one stale lock → exactly one acquires → M7 (R1)
- [ ] T1.4 (red) PID reuse: live-but-wrong-host / mismatched-startedAt owner → treated stale → M7 (R7)
- [ ] T1.5 (impl) `acquireStateLock`/`releaseStateLock`/`reclaimIfStale`/`isAlive` in `lib/state.mjs` (ARCH §3); ownership only from `mkdirSync` (R1); host+startedAt staleness (R7)
- [ ] T1.6 (impl) `sleepSync` with SAB feature-detect + `spawnSync` fallback (R8/FR10)
- [ ] T1.7 (impl) `withStateLock`; route `updateState` + public `saveState`; move `previousJobs` re-read inside lock
- [ ] T1.8 (impl) rewrite `cleanupSessionJobs` (`session-lifecycle-hook.mjs:52,70`) to one locked `updateState`; try/catch so shutdown never blocks (R2)
- [ ] T1.9 (wire) confirm `setConfig`/`upsertJob`/SessionEnd all locked; no stray `writeFileSync` to `state.json`
- [ ] T1.10 (impl) best-effort `process.on('exit')` release (not sole path, R4)
- [ ] T1.11 (green+refactor) suite green

## Phase 2 — Atomic writes + recovery (HIGH · F2 · R3,R5,R9,R10)
- [ ] T2.1 (red) atomic write: inject failure between temp-write and rename → prior parses → M3
- [ ] T2.2 (red) assert `fsyncDir` invoked after rename (R3)
- [ ] T2.3 (red) O_EXCL temp: second open of same temp path fails (R9)
- [ ] T2.4 (red) corrupt recovery (locked): `{` → `*.corrupt-*` + warn + default → M2
- [ ] T2.5 (red) corrupt recovery (unlocked): default, no rename, no throw (R5)
- [ ] T2.6 (impl) `atomicWriteFileSync` (O_EXCL → fsync file → renameOver → fsyncDir) (ARCH §4); apply `state.mjs:114,169`, `broker-lifecycle.mjs:92`
- [ ] T2.7 (impl) `loadState(cwd,{locked})` quarantine branch + R10 warning text (ARCH §5)
- [ ] T2.8 (impl) `renameOver` platform branch + `fsyncDir` best-effort skip (ARCH §7)
- [ ] T2.9 (green+refactor) Windows `renameOver` unit-tested with mocked fs

## Phase 3 — Process safety (MED/LOW · F3,F5)
- [ ] T3.1 (red) `tests/process.test.mjs`: argv-substring-`codex` / other-uid not selected → M4
- [ ] T3.2 (red) EPERM in group branch → `{delivered:false,reason:'permission'}`, no throw
- [ ] T3.3 (red) EPERM in single-process branch → same
- [ ] T3.4 (impl) `isOwnedCodexProcess` predicate (ARCH §6.1)
- [ ] T3.5 (impl) EPERM/ESRCH guard in both kill branches (ARCH §6.2)
- [ ] T3.6 (doc) PAI `init.md` cleanup → predicate + `uid==self` guard (OQ3)

## Phase 4 — Stop-gate UX (MED · F4 · R6)
- [ ] T4.1 (red) `parseStopReviewOutput` non-empty-odd → `{ok:true,warn}` → M5
- [ ] T4.2 (red) empty/timeout/non-zero/invalid-JSON → `{ok:false}` (R6)
- [ ] T4.3 (red) every block reason contains a runnable bypass command
- [ ] T4.4 (impl) narrow default branch (`stop-review-gate-hook.mjs:91`); thread `warn` to stderr
- [ ] T4.5 (impl) append bypass sentence to each block reason (ARCH §8)
- [ ] T4.6 (impl,opt) start-of-review stderr note for the 15-min block
- [ ] T4.7 (green) new `tests/stop-gate.test.mjs`

## Phase 5 — Effort knob + scope docs (LOW · F7 · R11)
- [ ] T5.1 (impl) PAI `init.md`: replace `max` with `xhigh` (`:21-22,202-203`)
- [ ] T5.2 (impl) init's launched commands pass `--effort xhigh`; note effective effort
- [ ] T5.3 (opt) add `--effort` to `argument-hint` for review commands; test in `tests/commands.test.mjs`
- [ ] T5.4 (doc) NFS/WSL2-DrvFs best-effort caveat in `docs/architecture.md` §7 + adapter notes (R11)

## Done-when (pack-level)
- [ ] M1–M7 pass; `npm test` + `npm run build` green; CI green (M6)
- [ ] no new runtime dependency
- [ ] old `state.json` loads unchanged
- [ ] crash never yields empty job list without a `*.corrupt-*` backup
- [ ] no code path signals a non-owned process
- [ ] each stop-gate block reason has a runnable bypass
- [ ] exactly one of two racing mutators reclaims a stale lock
