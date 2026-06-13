# Architecture — Codex Plugin Durability & Safety

**Status:** Draft for review · **Base commit:** `807e03a` · **Related:** [`PRD.md`](./PRD.md), [`PLAN.md`](./PLAN.md)

This document specifies the target design for the requirements in the PRD. It is
written against the current code so an implementer can map each change to a file.

---

## 1. Current state (as-is)

```
codex-companion.mjs ─┐
tracked-jobs.mjs ────┼─► upsertJob/updateState ─► loadState → mutate → saveState ─► fs.writeFileSync(state.json)
session-lifecycle ───┘                                  ▲                                   (non-atomic)
  (SessionEnd hook) ── saveState ────────────────────────┘
                                                   loadState catch(JSON err) ─► defaultState()  (silent wipe)
```

- `lib/state.mjs:92` `saveState` re-reads `previousJobs` **outside** any lock,
  then `fs.writeFileSync` (`:114`) straight onto `state.json`.
- `lib/state.mjs:58-78` `loadState` returns `defaultState()` on parse failure.
- No lock primitive exists anywhere (`grep -rE 'flock|O_EXCL|wx|lock'` → empty).
- Concurrent mutators: `tracked-jobs.mjs:102,152,169,194`,
  `codex-companion.mjs:668,961`, `session-lifecycle-hook.mjs:70`.

## 2. Target component map

```
                    ┌───────────────────────────────────────────┐
   all mutators ───►│  withStateLock(stateDir, fn)              │   ← NEW (FR1, FR2)
                    │    acquire ──► fn(reread→mutate→write) ──► │
                    │    release (finally + process exit)        │
                    └───────────────┬───────────────────────────┘
                                    ▼
                    ┌───────────────────────────────────────────┐
                    │  atomicWriteFileSync(target, data)        │   ← NEW (FR3)
                    │    write tmp(same dir) → fsync → rename     │
                    └───────────────────────────────────────────┘
   loadState ──► parse; on error ─► quarantine + warn (FR4), return empty-but-logged
   process.mjs ─► terminateProcessTree: EPERM ⇒ not-delivered (FR7)
   init cleanup ─► match basename / marker, skip non-owned PIDs (FR5)
   stop-gate hook ─► bypass in reason; ran-but-unparseable ⇒ allow+warn (FR6)
```

All new primitives live in `lib/state.mjs` (lock + atomic write + recovery) and
`lib/process.mjs` (EPERM). No new files are strictly required; a small
`lib/lockfile.mjs` is optional for testability.

## 3. Cross-process lock (FR1, FR2)

### 3.1 Primitive

Use an **atomic directory lock**: `fs.mkdirSync(lockDir)` is atomic and fails with
`EEXIST` if the directory exists — no extra dependency, works across processes on
all platforms. Path: `<stateDir>/.state.lock`.

Write an owner descriptor inside on acquire: `{ pid, host, startedAt }` to
`<stateDir>/.state.lock/owner.json` for liveness checks and diagnostics.

### 3.2 Acquire / release

```js
// lib/state.mjs (sketch)
const LOCK_DIR_NAME = ".state.lock";
const LOCK_TTL_MS = 30_000;        // a held lock older than this with a dead owner is stale
const LOCK_WAIT_MS = 10_000;       // max time a mutator waits for the lock
const LOCK_RETRY_MS = 25;          // poll interval

function acquireStateLock(stateDir) {
  const lockDir = path.join(stateDir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);                                   // atomic
      fs.writeFileSync(path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
      return lockDir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (reclaimIfStale(lockDir)) continue;                  // crashed owner ⇒ break in
      if (Date.now() > deadline) throw new Error("state lock busy");
      sleepSync(LOCK_RETRY_MS);                               // Atomics.wait on a SAB
    }
  }
}

function reclaimIfStale(lockDir) {
  const owner = safeReadOwner(lockDir);                       // null if missing/garbage
  const ageMs = Date.now() - Date.parse(owner?.startedAt ?? 0);
  const ownerAlive = owner?.pid && isAlive(owner.pid);        // kill(pid,0)
  if (!ownerAlive && ageMs > LOCK_TTL_MS) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function releaseStateLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}
```

- `sleepSync` uses `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)`
  — a true synchronous sleep with no busy-spin and no dependency. (The codebase is
  already synchronous via `spawnSync`, so a sync lock fits the call sites.)
- `isAlive(pid)` = `try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }`
  (EPERM means the PID exists but is owned by another user → still alive).

### 3.3 Critical-section wrapper

```js
export function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockDir = acquireStateLock(stateDir);
  try { return fn(); }
  finally { releaseStateLock(lockDir); }
}
```

`updateState` becomes the single choke point; **the re-read moves inside**:

```js
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);   // re-read INSIDE the lock (fixes the F1 race)
    mutate(state);
    return saveStateLocked(cwd, state);   // caller already holds the lock
  });
}
```

`saveState` (public) wraps `withStateLock(saveStateLocked)`. `saveStateLocked`
contains today's body **including** the `previousJobs` diff, now race-free because
the read and write are in the same locked section. The SessionEnd hook calls the
public `saveState`, so it participates automatically (FR1).

### 3.4 Crash safety of the lock itself

A process that dies holding the lock leaves `.state.lock/` behind. The next
mutator detects a dead owner PID past TTL and reclaims it (`reclaimIfStale`). No
manual cleanup, no permanent deadlock (FR2). Best-effort release is also wired to
`process.on('exit')` for the common case.

## 4. Atomic writes (FR3)

```js
function atomicWriteFileSync(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${randSuffix()}`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameOver(tmp, target);   // platform-aware, see §7
}
```

Apply to: `state.mjs:114` (state.json), `state.mjs:169` (job json files), and —
recommended — `broker-lifecycle.mjs:92` (broker session file). The empty-log
truncation at `tracked-jobs.mjs:53` is fine as-is.

## 5. Non-destructive recovery (FR4)

```js
export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) return defaultState();
  let raw;
  try { raw = fs.readFileSync(stateFile, "utf8"); }
  catch { return defaultState(); }
  try {
    return normalize(JSON.parse(raw));   // today's merge logic
  } catch {
    const backup = `${stateFile}.corrupt-${Date.now()}`;
    try { fs.renameSync(stateFile, backup); } catch { /* leave as-is */ }
    process.stderr.write(`[codex] state.json was unreadable; quarantined to ${backup}\n`);
    return defaultState();
  }
}
```

Key change: the **corrupt bytes are preserved** under `*.corrupt-*`, and a warning
is emitted. Orphaned PIDs can still be recovered from the backup by hand or a
future `/codex:status --recover`. The recovery happens **inside** the lock when
reached via `updateState`, so it cannot race a concurrent writer.

## 6. Process safety (FR5, FR7)

### 6.1 Matcher (FR5) — applies to the `init.md` cleanup pattern

Replace full-command-line substring matching with a precise predicate:

- Match on the **executable basename** of `argv[0]` ∈ {`codex`, `codex-companion`,
  `node` *only when* `argv[1]` resolves to the companion script path}, OR
- Presence of a marker env (`CODEX_COMPANION_SESSION_ID`) on the process, OR
- The PID is one this plugin tracked in `state.json`.
- AND `processUid === currentUid` — never signal a process owned by another user
  (this alone would have spared `earlyoom`, owned by root).

Primary teardown stays tracked-PID based (`terminateProcessTree(job.pid)` in the
SessionEnd hook) — the matcher is only a backstop for orphans.

### 6.2 EPERM handling (FR7) — `lib/process.mjs:100-118`

```js
} catch (error) {
  if (error?.code === "ESRCH" || error?.code === "EPERM") {
    return { attempted: true, delivered: false, method: "process-group",
             reason: error.code === "EPERM" ? "permission" : "not-found" };
  }
  // fall through to single-process attempt, repeating the EPERM/ESRCH guard
}
```

A reparented or privileged PID now yields a clean "not delivered (permission)"
instead of crashing `/codex:cancel` or the SessionEnd hook.

## 7. Cross-platform notes (NFR3)

| Concern | POSIX | Windows |
|---------|-------|---------|
| `rename` over existing file | atomic replace | fails if target exists → `renameOver` does `try rename; on EEXIST/EPERM: unlinkSync(target); rename` (small non-atomic window, acceptable; or `fs.renameSync` after `copyFileSync` to a sibling) |
| Directory lock `mkdir` | atomic | atomic |
| Liveness `kill(pid,0)` | works | works via libuv |
| Process-group kill `kill(-pid)` | works | N/A — already branched to `taskkill /T` in `process.mjs:66` |

`renameOver` is the only platform branch needed; everything else is already
guarded in the existing code.

## 8. Stop-gate UX (FR6) — `stop-review-gate-hook.mjs`

Two surgical changes, no structural rewrite:

1. **Distinguish "ran but unparseable" from "did not run."** In
   `parseStopReviewOutput` (`:69`), the current default returns `ok:false` →
   blocks. Change the *unrecognized-format-but-non-empty* branch to
   `{ ok: true, warn: "<text>" }`; keep empty/timeout/non-zero-exit as blocking.
   The gate still blocks on genuine failures, but a completed review with an
   odd preamble no longer traps the session.
2. **Put the bypass in the reason.** Everywhere a block reason is built
   (`:75,:87,:94,:116,:126,:137,:170`), append:
   `Bypass: run /codex:setup to disable the stop-review gate, or /codex:review --wait to review now.`

Optional: emit a `[codex] stop-review running… (up to 15m)` note to stderr at the
start of `runStopReview` so the long synchronous block isn't silent.

## 9. Data model

Unchanged. No new fields in `state.json`, jobs, or config. The lock directory and
`*.corrupt-*` / `*.tmp-*` files are siblings of `state.json` inside the existing
per-workspace state dir and are ignored by everything that reads jobs.

## 10. Sequence — the F1 race, before vs. after

```
BEFORE (lost update):
  t0  bg job:    load(state{job=running})
  t1  SessionEnd:load(state{job=running})
  t2  bg job:    write(state{job=completed})
  t3  SessionEnd:write(state{job removed})     ← completion lost

AFTER (serialized):
  t0  bg job:    lock ✔ → load → write(completed) → unlock
  t1  SessionEnd:lock(wait) ✔ → load(sees completed) → decide → unlock
```

## 11. Alternatives considered

- **`open(path,'wx')` lockfile** instead of `mkdir`: equivalent atomicity, but a
  stale empty file is marginally harder to reason about than a directory; `mkdir`
  chosen for clarity. Either satisfies FR1/FR2.
- **`proper-lockfile` npm package:** rejected — violates NFR1 (no new deps).
- **SQLite/better-sqlite3 for state:** rejected — violates N1/NFR1; overkill for a
  ≤50-job capped list.
- **Async lock via `fs.promises` + queue in one process:** rejected — does not
  protect against *other* processes (the broker, hooks, separate sessions), which
  is the actual failure mode.
- **Append-only job log + compaction:** stronger durability, larger change;
  deferred. The lock + atomic-write + recovery trio closes the observed gaps with
  a far smaller blast radius.
