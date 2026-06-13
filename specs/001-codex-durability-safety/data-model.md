# Data Model — Codex Plugin Durability & Safety

**Feature:** 001-codex-durability-safety · **Status:** Unchanged by this feature (P2)

No schema fields change. This documents the existing shapes the lock/atomic-write/
recovery layer operates on, plus the new **on-disk artifacts** (not schema, just
sibling files) the feature introduces.

---

## 1. `state.json` (existing — unchanged)

`lib/state.mjs` `defaultState()`:

```jsonc
{
  "version": 1,                       // STATE_VERSION
  "config": { "stopReviewGate": false },
  "jobs": [ /* Job[], capped at MAX_JOBS = 50, pruned by updatedAt desc */ ]
}
```

Location: `resolveStateDir(cwd)/state.json` where the dir is
`<CLAUDE_PLUGIN_DATA>/state/<slug>-<sha256(realpath)[:16]>` or, absent that env,
`os.tmpdir()/codex-companion/<slug>-<hash>` (`state.mjs:29-44`).

## 2. Job (existing — unchanged)

Fields observed in `tracked-jobs.mjs` / `state.mjs` upserts: `id`, `status`
(`queued|running|completed|failed|…`), `sessionId`, `pid`, `logFile`, `createdAt`,
`updatedAt`, plus job-type/result pointers. `upsertJob` stamps `createdAt`/`updatedAt`.
Job detail files: `resolveJobsDir(cwd)/<jobId>.json`; logs `<jobId>.log`.

## 3. Config (existing — unchanged)
`{ stopReviewGate: boolean }`, merged over defaults on load (`state.mjs:69-72`).

## 4. NEW on-disk artifacts (not schema — P2 preserved)

| Artifact | Path | Lifetime | Read by job logic? |
|----------|------|----------|--------------------|
| Lock directory | `<stateDir>/.state.lock/` | held during a mutation; reclaimed if stale | no (sibling, ignored) |
| Lock owner descriptor | `<stateDir>/.state.lock/owner.json` = `{pid, host, startedAt}` | with the lock dir | only by reclaim logic |
| Atomic temp | `<dir>/.<name>.tmp-<pid>-<rand>` (`O_EXCL`) | between write and rename | no |
| Corrupt quarantine | `<stateDir>/state.json.corrupt-<ts>` | until manually cleared | no (diagnostic only) |

These are all siblings of `state.json` inside the per-workspace state dir. Every job
reader (`loadState` normalize, `listJobs`, `/codex:status`) ignores files it doesn't
explicitly resolve, so their presence is invisible to existing behavior (P2/NFR4).

## 5. Invariants
- `jobs` is always an array (`Array.isArray` guard, `state.mjs:73`).
- `config` always has `stopReviewGate` (default-merge, `:69-72`).
- After any locked mutation, `state.json` parses (atomic write, B2).
- At most one `.state.lock/` exists per state dir at a time; a second is `EEXIST`.
- `owner.json` host = creator's `os.hostname()`; used to reject cross-host liveness.
