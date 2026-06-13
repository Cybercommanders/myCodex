# Architecture — Codex Plugin Durability & Safety

**Status:** Canonical · **Base commit:** `807e03a`
**Related:** [`PRD.md`](./PRD.md), [`reviews/CONSOLIDATED.md`](./reviews/CONSOLIDATED.md),
[`../specs/001-codex-durability-safety/`](../specs/001-codex-durability-safety/)

Target design for the PRD requirements, written against the current code so an
implementer can map each change to a file:line. Hardened with the 11 review findings
(R1–R11) folded into v0.2.

---

## 1. Current state (as-is)

```
codex-companion.mjs ─┐
tracked-jobs.mjs ────┼─► upsertJob/updateState ─► loadState → mutate → saveState ─► fs.writeFileSync(state.json)
session-lifecycle ───┘                                  ▲                                   (non-atomic)
  (SessionEnd hook) ── loadState→filter→saveState ───────┘  (UNLOCKED read-modify-write — R2)
                                                   loadState catch(JSON err) ─► defaultState()  (silent wipe)
```

- `lib/state.mjs:92-93` `saveState` re-reads `previousJobs` **outside** any lock,
  then `fs.writeFileSync` (`:114`) straight onto `state.json` (non-atomic).
- `lib/state.mjs:64-77` `loadState` returns `defaultState()` on parse failure.
- No lock primitive exists (`grep -rE 'flock|O_EXCL|wx|lock'` over `lib/` → empty).
- Concurrent mutators: `tracked-jobs.mjs:102,152,169,194`,
  `codex-companion.mjs` (job spawn), `session-lifecycle-hook.mjs:52,70`.
- Unlocked readers that call `loadState`: `listJobs` (`:149`), `getConfig` (`:162`),
  used by `/codex:status` and `stop-review-gate-hook.mjs:11,148`.

## 2. Target component map

```
                    ┌───────────────────────────────────────────┐
   all mutators ───►│  withStateLock(cwd, fn)                   │   ← NEW (FR1, FR2, FR9, FR10)
   incl. SessionEnd │    acquire ──► fn(reread→mutate→write) ──► │
   (R2)             │    release (finally; exit = best-effort)   │
                    └───────────────┬───────────────────────────┘
                                    ▼
                    ┌───────────────────────────────────────────┐
                    │  atomicWriteFileSync(target, data)        │   ← NEW (FR3, R3, R9)
                    │   open(tmp,'wx') → write → fsync(file) →   │
                    │   rename → fsync(dir)                       │
                    └───────────────────────────────────────────┘
   loadState ──► parse; on error ─► quarantine-IF-LOCKED + warn (FR4, R5, R10)
   process.mjs ─► terminateProcessTree: EPERM ⇒ not-delivered, both branches (FR7)
   init cleanup ─► isOwnedCodexProcess() basename/marker/uid (FR5)
   stop-gate hook ─► bypass in reason; non-empty-odd ⇒ allow+warn; failures still block (FR6, R6)
```

New primitives live in `lib/state.mjs` (lock + atomic write + recovery) and
`lib/process.mjs` (EPERM + matcher). An optional `lib/lockfile.mjs` may host the lock
for unit isolation.

## 3. Cross-process lock (FR1, FR2, FR9, FR10)

### 3.1 Primitive
Atomic **directory lock**: `fs.mkdirSync(lockDir)` is atomic and fails `EEXIST` if it
exists. Path `<stateDir>/.state.lock`. Owner descriptor
`<stateDir>/.state.lock/owner.json` = `{ pid, host, startedAt }` — `host` and
`startedAt` are load-bearing for PID-reuse detection (R7).

### 3.2 Acquire / release / reclaim (TOCTOU-safe — R1, R7)

```js
const LOCK_DIR_NAME = ".state.lock";
const LOCK_TTL_MS   = 30_000;   // dead owner older than this ⇒ stale
const LOCK_WAIT_MS  = 10_000;   // max wait for the lock
const LOCK_RETRY_MS = 25;

function acquireStateLock(stateDir) {
  const lockDir = path.join(stateDir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);                                   // atomic — ONLY proof of ownership (R1)
      fs.writeFileSync(path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: nowIso() }));
      return lockDir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      reclaimIfStale(lockDir);     // may rmSync a dead lock — does NOT grant ownership
      if (Date.now() > deadline) throw new Error("state lock busy");
      sleepSync(LOCK_RETRY_MS);
    }
  }
}
```

**R1 fix:** `reclaimIfStale` only ever *removes* a stale lock. Ownership is granted
**solely** by the subsequent `mkdirSync` succeeding. Two processes that both reclaim
will both loop; exactly one's `mkdirSync` wins, the other gets `EEXIST` and waits.

```js
function reclaimIfStale(lockDir) {
  const owner = safeReadOwner(lockDir);                       // null if missing/garbage
  const ownerLocal = owner && owner.host === os.hostname();
  const ageMs = Date.now() - Date.parse(owner?.startedAt ?? 0);
  // alive only if same host AND pid live AND not past TTL (R7: cross-host or recycled PID ⇒ stale)
  const ownerAlive = ownerLocal && owner.pid && isAlive(owner.pid) && ageMs <= LOCK_TTL_MS;
  if (!ownerAlive) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }   // EPERM ⇒ exists, owned by another user
}
```

> **R7 note:** PID liveness alone is insufficient (the OS recycles PID numbers). A
> live PID is only treated as the lock owner when `host` matches *and* `startedAt` is
> within TTL. A different host's descriptor (shared state dir on a network mount) is
> always stale-eligible.

```js
function releaseStateLock(lockDir) { try { fs.rmSync(lockDir, { recursive:true, force:true }); } catch {} }
```

- **`sleepSync` (R8/FR10):** prefer
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)` when
  `typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function"`;
  else fall back to `spawnSync(process.execPath,["-e","setTimeout(()=>{}, "+ms+")"])`
  or a bounded busy-check. The plugin runs under Node (children via
  `process.execPath`), where SAB is present; the guard is defence-in-depth.

### 3.3 Critical-section wrapper

```js
export function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockDir = acquireStateLock(stateDir);
  try { return fn(); } finally { releaseStateLock(lockDir); }
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd, { locked: true });  // re-read INSIDE the lock (F1) — quarantine allowed (R5)
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}
```

`saveState` (public) = `withStateLock(() => saveStateLocked(...))`. `saveStateLocked`
holds today's body **including** the `previousJobs` diff, now race-free.
**R2:** the SessionEnd hook's `cleanupSessionJobs` (`session-lifecycle-hook.mjs:52,70`)
is rewritten to a single `updateState(workspaceRoot, state => { ... filter ... })` so
its load + filter + save are one locked section; failures are caught so shutdown is
never blocked (OQ2).

### 3.4 Crash safety of the lock (R4)
A process dying with the lock leaves `.state.lock/`. The next mutator detects a dead
or cross-host owner past TTL and reclaims (`reclaimIfStale`). `process.on('exit')`
release is wired for the *graceful* case only — **it does not run on SIGKILL/OOM**, so
correctness rests entirely on TTL reclaim (FR9), not on the exit handler.

## 4. Atomic writes (FR3, R3, R9)

```js
function atomicWriteFileSync(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${randSuffix()}`);
  const fd = fs.openSync(tmp, "wx");          // O_EXCL — no shared temp (R9)
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  renameOver(tmp, target);                    // platform-aware, §7
  fsyncDir(dir);                              // make the rename durable (R3)
}

function fsyncDir(dir) {
  let dfd; try { dfd = fs.openSync(dir, "r"); fs.fsyncSync(dfd); }
  catch { /* some platforms (Windows) can't fsync a dir — best-effort */ }
  finally { if (dfd !== undefined) try { fs.closeSync(dfd); } catch {} }
}
```

Apply to: `state.mjs:114` (state.json), `state.mjs:169` (job json), and
`broker-lifecycle.mjs:92` (broker session file). The empty-log truncation at
`tracked-jobs.mjs:53` is fine as-is.

## 5. Non-destructive recovery (FR4, R5, R10)

```js
export function loadState(cwd, { locked = false } = {}) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) return defaultState();
  let raw; try { raw = fs.readFileSync(stateFile, "utf8"); } catch { return defaultState(); }
  try { return normalize(JSON.parse(raw)); }
  catch {
    if (!locked) return defaultState();          // R5: unlocked readers never rename
    const backup = `${stateFile}.corrupt-${Date.now()}`;
    try { fs.renameSync(stateFile, backup); } catch { /* leave as-is */ }
    process.stderr.write(`[codex] state.json was unreadable; quarantined to ${backup}. `
      + `Any background jobs it tracked may be orphaned — inspect the backup or run /codex:status.\n`);  // R10
    return defaultState();
  }
}
```

- **R5:** the rename-aside happens **only** when `locked` (i.e. reached via
  `updateState`). `/codex:status`, the gate, `getConfig`, and `listJobs` pass
  `locked:false` and never mutate the filesystem — no race with a concurrent writer.
- **R10:** corrupt bytes are preserved under `*.corrupt-*` and the warning explicitly
  names the orphan risk + the backup path, so the operator has a recovery pointer.

## 6. Process safety (FR5, FR7)

### 6.1 Matcher (FR5) — pure, unit-testable predicate

```js
export function isOwnedCodexProcess({ argv0, argv1, uid, env, trackedPids, pid }) {
  if (trackedPids?.includes(pid)) return uid === process.getuid?.();
  if (uid !== process.getuid?.()) return false;            // never signal another user (spares earlyoom/root)
  const base = path.basename(argv0 ?? "");
  if (base === "codex" || base === "codex-companion") return true;
  if (base === "node" && /codex-companion\.mjs$/.test(argv1 ?? "")) return true;
  if (env?.CODEX_COMPANION_SESSION_ID) return true;
  return false;                                            // substring "codex" in argv is NOT a match
}
```

Primary teardown stays tracked-PID based (`terminateProcessTree(job.pid)` in the
SessionEnd hook); the matcher is a backstop for orphans only. The `/codex:init`
cleanup block in PAI `init.md` adopts this predicate + the `uid==self` guard (OQ3).

### 6.2 EPERM (FR7) — `lib/process.mjs:100-118`, both branches

```js
function classifyKillError(error, method) {
  if (error?.code === "ESRCH" || error?.code === "EPERM") {
    return { attempted: true, delivered: false, method,
             reason: error.code === "EPERM" ? "permission" : "not-found" };
  }
  return null; // genuine error ⇒ caller rethrows / falls through
}
```

Applied to the process-group kill (`:101`) **and** the single-process fallback
(`:107`): a reparented or privileged PID yields `{delivered:false, reason:'permission'}`
instead of crashing `/codex:cancel` or the SessionEnd hook.

## 7. Cross-platform notes (NFR3, NFR6, R11)

| Concern | POSIX | Windows | Networked / DrvFs (R11) |
|---------|-------|---------|--------------------------|
| `rename` over existing | atomic replace | fails if target exists → `renameOver`: try rename; on EEXIST/EPERM `unlinkSync(target)`+`rename` (small non-atomic window) | atomicity **not guaranteed** — best-effort, documented |
| Directory lock `mkdir` | atomic | atomic | NFS `mkdir` not reliably atomic — best-effort |
| `fsync(dir)` | works | may throw → best-effort skip | varies |
| Liveness `kill(pid,0)` | works | via libuv | host field disambiguates (R7) |
| Process-group `kill(-pid)` | works | N/A → `taskkill /T` (`process.mjs:66`) | — |

`renameOver` + `fsyncDir`'s best-effort skip are the only platform branches.
**NFR6/N5:** when the state root is relocated onto NFS/SMB/`/mnt/*` (WSL2 DrvFs),
guarantees degrade to best-effort; the default root is `os.tmpdir()` /
`CLAUDE_PLUGIN_DATA` (`state.mjs:10,41-43`), normally local.

## 8. Stop-gate UX (FR6, R6) — `stop-review-gate-hook.mjs`

Two surgical changes, no structural rewrite:

1. **Distinguish "ran but odd" from "did not run" (R6, narrowed).** In
   `parseStopReviewOutput` (`:69-96`), the *non-empty, unrecognized-but-present*
   branch (`:91`) returns `{ ok:true, warn:text }`. The four genuine-failure paths
   stay blocking: empty output (`:72`), timeout (`:112`), non-zero exit (`:120`),
   invalid JSON (`:133`). The fail-open window is therefore "a review process that
   exited 0, produced parseable JSON with a non-empty `rawOutput`, but whose first
   line isn't `ALLOW:`/`BLOCK:`" — a completed-but-formatted-oddly review, never a
   crash.
2. **Put the bypass in every block reason** (`:75,:87,:94,:116,:126,:137`):
   append `Bypass: run /codex:setup to disable the stop-review gate, or
   /codex:review --wait to review now.`

Optional: a `[codex] stop-review running… (up to 15m)` stderr note at the start of
`runStopReview` (`:98`) so the long synchronous block isn't silent.

## 9. Data model
Unchanged (see [`spec data-model`](../specs/001-codex-durability-safety/data-model.md)).
No new `state.json` / job / config fields. Lock dir, `*.corrupt-*`, `*.tmp-*` are
siblings ignored by all job readers.

## 10. Sequence — the F1 race, before vs after

```
BEFORE (lost update):
  t0  bg job:     load(state{job=running})
  t1  SessionEnd: load(state{job=running})          ← unlocked (R2)
  t2  bg job:     write(state{job=completed})
  t3  SessionEnd: write(state{job removed})          ← completion lost

AFTER (serialized):
  t0  bg job:     lock ✔ → load → write(completed) → unlock
  t1  SessionEnd: lock(wait) ✔ → load(sees completed) → filter → unlock
```

## 11. Alternatives considered
- `open(path,'wx')` lockfile vs `mkdir`: equivalent atomicity; `mkdir` chosen for
  clarity (owner descriptor lives naturally inside). (OQ1 resolved.)
- `proper-lockfile` npm: rejected (NFR1, no new deps).
- SQLite/better-sqlite3: rejected (N1/NFR1; overkill for a ≤50-job capped list).
- Async in-process lock: rejected — doesn't protect *other* processes, the real bug.
- Append-only job log + compaction: deferred — stronger durability, larger blast
  radius; the lock + atomic-write + recovery trio closes the observed gaps minimally.
