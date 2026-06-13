# Spec — Codex Plugin Durability & Safety

**Feature:** 001-codex-durability-safety · **Base commit:** `807e03a`
**Source of truth:** [`../../docs/PRD.md`](../../docs/PRD.md) ·
[`../../docs/architecture.md`](../../docs/architecture.md) ·
[`constitution.md`](./constitution.md)

This spec restates the canonical PRD as testable, implementation-facing behavior. Each
section ties to FRs and to the metrics (M1–M7) that verify them.

---

## 1. Scope

In: cross-process state lock; atomic writes (file + dir fsync, O_EXCL temp);
non-destructive corrupt recovery (locked-only quarantine); process-match safety + uid
guard; EPERM handling in both kill branches; Stop-gate fail-open narrowing + bypass
text; `/codex:init` effort-knob fix.

Out: broker transport, verdict schema, networked-fs correctness (best-effort only),
append-only log, harness hook dispatch.

## 2. Functional behavior

### B1 — Serialized mutations (FR1, FR2, FR9, FR10) → M1, M7
- All writes to `state.json` go through `withStateLock(cwd, fn)`.
- The current state is **re-read inside the lock** before computing the next state.
- Callers covered: `updateState`, public `saveState`, `setConfig`, `upsertJob`, and
  `cleanupSessionJobs` in `session-lifecycle-hook.mjs` (rewritten to one locked RMW).
- Lock = atomic `mkdir` of `<stateDir>/.state.lock`; owner descriptor
  `{pid, host, startedAt}`.
- **Reclaim is TOCTOU-safe:** ownership is granted only by a successful `mkdirSync`,
  never by removing a stale lock.
- **Stale = not (same host AND live PID AND age ≤ TTL).** Cross-host or recycled-PID
  owners are reclaimable.
- The synchronous wait does not busy-spin; `Atomics.wait`/SAB when present, bounded
  `spawnSync` sleep otherwise.

### B2 — Atomic, durable writes (FR3) → M3
- Write to a same-directory temp opened with `O_EXCL`; `fsync` the file; `rename`
  over the target; `fsync` the directory.
- Applied to `state.json`, job json files, broker session file.
- A crash between temp-write and rename leaves the previous `state.json` parseable.

### B3 — Non-destructive recovery (FR4) → M2
- A parse failure during a **locked** load renames the bad file to
  `state.json.corrupt-<ts>`, emits a warning naming the backup + orphan risk, returns
  default.
- A parse failure during an **unlocked** load returns default **without renaming**.
- Corrupt bytes are always retained.

### B4 — Process safety (FR5, FR7) → M4
- `isOwnedCodexProcess(...)` matches by basename (`codex`/`codex-companion`/`node`+
  companion path), marker env, or tracked PID — never by argv substring — and only
  when `uid === self`.
- `terminateProcessTree` returns `{delivered:false, reason}` on `EPERM`/`ESRCH` in
  both the process-group and single-process branches; never throws on them.

### B5 — Stop-gate UX (FR6) → M5
- `parseStopReviewOutput`: non-empty, recognized-as-review-but-odd → `{ok:true,
  warn}`. Empty / timeout / non-zero exit / invalid JSON → `{ok:false}` (block).
- Every block reason ends with a runnable bypass command.

### B6 — Effort knob (FR8)
- `/codex:init` (`~/.claude/skills/codex/init.md`) replaces `max` with `xhigh` and
  passes `--effort xhigh` to the commands it launches; valid tokens documented as
  `none|minimal|low|medium|high|xhigh`.

## 3. Acceptance criteria (pack-level)
- [ ] M1–M7 pass; `npm test` green; CI green (M6).
- [ ] No new runtime dependency (`package.json` runtime deps unchanged).
- [ ] Old `state.json` files load unchanged.
- [ ] A simulated crash never yields an empty job list without a `*.corrupt-*` backup.
- [ ] No code path signals a process not owned by the current user.
- [ ] Each stop-gate block reason contains a runnable bypass command.
- [ ] Exactly one of two racing mutators reclaims a stale lock (no double-ownership).

## 4. Edge cases (from review)
- Two processes reclaim the same stale lock simultaneously → exactly one acquires (R1).
- Owner PID recycled by an unrelated live process → treated as stale (R7).
- Lock holder SIGKILLed → next mutator reclaims via TTL, not via exit handler (R4).
- `/codex:status` runs while a writer holds the lock and the file is corrupt → reader
  returns default, does not rename, does not throw (R5).
- Review process crashes but prints a banner to stdout → still blocks (R6).
- State root relocated onto `/mnt/c` (WSL2 DrvFs) → best-effort, documented (R11).
