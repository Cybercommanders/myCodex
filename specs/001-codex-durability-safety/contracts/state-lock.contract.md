# Contract — State Lock (`lib/state.mjs`)

Covers FR1, FR2, FR9, FR10. Verified by M1, M7.

## `withStateLock(cwd, fn) → ReturnType<fn>`
- **Pre:** `cwd` resolves to a workspace; state dir is creatable.
- **Behavior:** ensures state dir; `acquireStateLock`; runs `fn` (which re-reads,
  mutates, writes); releases the lock in `finally`.
- **Post:** lock released on success, throw, and (best-effort) process exit.
- **Guarantee:** at most one process is inside `fn` for a given state dir at a time.

## `acquireStateLock(stateDir) → lockDir`
- Returns only after a successful atomic `mkdirSync(<stateDir>/.state.lock)`.
- Writes `owner.json = {pid, host: os.hostname(), startedAt: ISO}`.
- On `EEXIST`: calls `reclaimIfStale` (removal only), then retries until `LOCK_WAIT_MS`.
- Throws `"state lock busy"` past the deadline.
- **MUST NOT** derive ownership from removing a stale lock (R1).

## `reclaimIfStale(lockDir) → void`
- Reads `owner.json`; `ownerAlive = sameHost && pidLive && age ≤ LOCK_TTL_MS`.
- If not alive: `rmSync(lockDir, {recursive,force})`. Removal only — never returns a
  "you now own it" signal (R1).
- `pidLive` via `isAlive`; `EPERM` ⇒ alive (other user). Cross-host or recycled-PID
  (host/startedAt mismatch) ⇒ stale (R7).

## `sleepSync(ms) → void`
- `Atomics.wait` on a `SharedArrayBuffer` when both are `typeof === "function"`;
  else a bounded `spawnSync` sleep (R8/FR10). No busy-spin.

## Constants
`LOCK_DIR_NAME=".state.lock"`, `LOCK_TTL_MS=30_000`, `LOCK_WAIT_MS=10_000`,
`LOCK_RETRY_MS=25`.

## Mutators that MUST route through the lock
`updateState`, public `saveState`, `setConfig`, `upsertJob`, and
`session-lifecycle-hook.mjs` `cleanupSessionJobs` (R2). Readers (`listJobs`,
`getConfig`, `/codex:status`) MUST NOT lock (P4).
