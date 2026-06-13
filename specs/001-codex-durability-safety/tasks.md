# Tasks — Codex Plugin Durability & Safety

TDD order. `[ ]` = todo. Each test task is **red-first**. `→ M#` = metric verified.
Findings: F1–F7 (proposal), R1–R11 (review), **RC1–RC6 (v0.3 reconcile)**.

> **v0.3:** former Phase 1 + Phase 2 are merged into **Phase D — Durability Unit**:
> per all three reviewers they MUST ship together (P1 alone leaves writes non-atomic
> and corrupt-reset live). RC1 (token + graveyard-rename + fencing), RC2 (job-file
> reconstruction), RC4 (Windows `.bak`), RC5 (per-uid `0o700`) folded in.

---

## Phase D — Durability Unit (HIGH · F1+F2 · ships as ONE PR · R1–R5,R7–R10, RC1,RC2,RC4,RC5)

### D.A — Cross-process lock (F1)
- [ ] TD.1 (red) `tests/state.test.mjs`: N≥20 parallel `upsertJob` children, assert 0 lost → M1
- [ ] TD.2 (red) stale-lock reclaim: dead PID + old `startedAt` reclaimed within TTL → M7
- [ ] TD.3 (red) **RC1** reclaim race: two racing mutators on one stale lock → exactly one acquires; a reclaimer that renames a **fresh** holder's lock (token mismatch) restores it → M7
- [ ] TD.4 (red) **RC1** holder fencing: token cleared mid-section → `assertStillOwner` throws `ELOCKLOST` → `withStateLock` re-acquires, commit not lost → M7
- [ ] TD.5 (red) **R7** PID reuse: live-but-wrong-host / mismatched-startedAt owner → treated stale → M7
- [ ] TD.6 (impl) `acquireStateLock` (per-acq **token**, `{token,pid,host,startedAt}`), `reclaimIfStale` (graveyard-`rename` + token re-verify + restore-on-mismatch, **never** `rmSync` live path), `assertStillOwner`, `isAlive`, `releaseStateLock` (ARCH §3.2)
- [ ] TD.7 (impl) `sleepSync` with SAB feature-detect + `spawnSync` fallback (R8/FR10)
- [ ] TD.8 (impl) `withStateLock` (bounded re-acquire on `ELOCKLOST`); route `updateState` + public `saveState`; re-read inside lock + `assertStillOwner` before commit (ARCH §3.3)
- [ ] TD.9 (impl) rewrite `cleanupSessionJobs` (`session-lifecycle-hook.mjs:52,70`) to one locked `updateState`; try/catch so shutdown never blocks (R2)
- [ ] TD.10 (wire) `setConfig`/`upsertJob`/SessionEnd all locked; no stray `writeFileSync` to `state.json`; best-effort `process.on('exit')` release (not sole path, R4)

### D.B — Atomic + crash-safe writes & recovery (F2)
- [ ] TD.11 (red) atomic write: inject failure between temp-write and rename → prior parses; `fsyncDir` invoked → M3 (R3)
- [ ] TD.12 (red) **R9** O_EXCL temp: second open of same temp path fails
- [ ] TD.13 (red) **RC4** Windows `renameOver`: crash between `unlink(target)` and `rename` → `loadState` recovers from `.bak`, never empty → M3
- [ ] TD.14 (red) **RC2** corrupt recovery (locked): `{` in `state.json` + intact `jobs/*.json` → `*.corrupt-*` backup + **jobs reconstructed** (PIDs survive), warn → M2
- [ ] TD.15 (red) **R5** corrupt recovery (unlocked): default, no rename, no throw
- [ ] TD.16 (impl) `atomicWriteFileSync` (O_EXCL → fsync file → `renameOver` → `fsyncDir`); apply `state.mjs:114,169`, `broker-lifecycle.mjs:92` (ARCH §4)
- [ ] TD.17 (impl) `renameOver` (POSIX atomic; Windows `.bak`-snapshot→unlink→rename) + `fsyncDir` best-effort skip (ARCH §4/§7)
- [ ] TD.18 (impl) `loadState(cwd,{locked})`: `.bak` recovery when target missing (RC4); locked quarantine + `reconstructFromJobFiles` (RC2); unlocked never renames (R5) (ARCH §5)
- [~] TD.19 (impl) **RC5 — DEFERRED to follow-up issue.** Shared-tmp multi-user hardening is inherently TOCTOU on a world-writable path; out of scope. Only NFR4 kept: `resolveStateDir` path is unchanged (no relocation, no strand). Use `CLAUDE_PLUGIN_DATA` for hostile multi-user hosts.
- [ ] TD.20 (green+refactor) full suite green; `npm run build` green

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
