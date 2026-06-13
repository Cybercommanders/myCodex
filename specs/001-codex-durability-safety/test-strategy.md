# Test Strategy — Codex Plugin Durability & Safety

**Method:** TDD (P3) — red test first, minimal green, refactor. Runner:
`node --test tests/*.test.mjs` (`package.json` `test` script). No real Codex CLI; use
`tests/fake-codex-fixture.mjs` + `tests/helpers.mjs` `makeTempDir`.

---

## Metric → test matrix

| Metric | FR | Phase | File | Technique |
|--------|----|-------|------|-----------|
| M1 concurrent upsert, 0 lost | FR1 | P1 | `tests/state.test.mjs` | spawn N≥20 child `node -e` procs each `upsertJob`; assert all ids present |
| M7 stale-lock reclaim (single + race) | FR2/FR9 | P1 | `tests/state.test.mjs` | seed `.state.lock/owner.json` dead-PID/old-ts; 1 mutator reclaims; 2 racing → exactly 1 acquires (R1); wrong-host live PID → stale (R7) |
| M2 corrupt → quarantine+warn (locked) / no-op (unlocked) | FR4 | P2 | `tests/state.test.mjs` | write `{`; locked `loadState` → `*.corrupt-*` + warn; unlocked → default, no rename (R5) |
| M3 crash mid-write → prior parses; dir-fsync called | FR3 | P2 | `tests/state.test.mjs` | inject fs that throws between rename steps; assert prior parses; spy `fsyncDir` (R3); O_EXCL temp double-open fails (R9) |
| M4 substring-`codex`/other-uid not killed | FR5 | P3 | `tests/process.test.mjs` | table-drive `isOwnedCodexProcess` cases |
| (EPERM) both kill branches | FR7 | P3 | `tests/process.test.mjs` | inject `killImpl` throwing EPERM in group + single branch |
| M5 odd→allow, failures→block, bypass in reason | FR6 | P4 | `tests/stop-gate.test.mjs` (new) | unit `parseStopReviewOutput` + `runStopReview` with injected spawn result |
| (effort) docs/runtime agree | FR8 | P5 | `tests/commands.test.mjs` | assert no `max` token; `--effort` forwarded |
| M6 no regression | all | all | `npm test` + `pull-request-ci.yml` | full suite green |

## Multi-process testing
M1/M7 require *real* OS processes (the bug is cross-process). Use
`child_process.spawnSync(process.execPath, ["-e", script])` fan-out against a shared
temp state dir; assert on the final `state.json`. In-process async mocks do **not**
exercise the lock (review note: async in-process lock was rejected for exactly this
reason).

## Injection seams (keep impl testable)
- `terminateProcessTree(pid, { killImpl, runCommandImpl, platform })` — already
  parameterized (`process.mjs:62-64`); extend tests to both branches.
- `atomicWriteFileSync` — accept an injectable `fsImpl` (or monkeypatch `node:fs`) so a
  failure can be forced between temp-write and rename, and `fsyncDir` spied.
- `loadState(cwd, { locked })` — the `locked` flag is the seam for R5 coverage.
- `isOwnedCodexProcess(...)` — pure function, no seam needed.
- `parseStopReviewOutput` / `runStopReview` — pass a fake spawn result object.

## Regression guard
`tests/state.test.mjs` already covers `resolveStateDir` + prune semantics; new lock/
atomic/recovery tests must not break those (they assert P2 backward-compat).

## CI
`pull-request-ci.yml` runs `npm test` + `npm run build`. Windows `renameOver` /
`fsyncDir` paths unit-tested with a mocked `fs` (no Windows runner required).
