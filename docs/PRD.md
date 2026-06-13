# PRD — Codex Plugin Durability & Safety

**Status:** Canonical (consolidated) · **Version:** v0.3-reconcile
**Base commit:** `807e03a` · **Project:** `Cybercommanders/codex-plugin-cc`
**Related:** [`docs/architecture.md`](./architecture.md), [`specs/001-codex-durability-safety/`](../specs/001-codex-durability-safety/)
**Reviews folded in:** [`docs/reviews/CONSOLIDATED.md`](./reviews/CONSOLIDATED.md)

> This canonical PRD merges the original proposal pack
> (`docs/proposals/codex-durability-safety/PRD.md`) with the multi-model review
> findings gathered this session (Opus 4.8 reviewer + GPT-5.5-xhigh via Codex, both
> at max effort; Fable channel off). The review surfaced 11 hardening findings that
> sharpen — but do not overturn — the original seven.
>
> **v0.3 reconcile.** A later GPT-5.4 adversarial pass (which landed after the v0.2
> merge) plus a reconcile audit found that v0.2 left four blockers open and
> *over-claimed* the lock-reclaim fix. v0.3 closes them: token + graveyard-rename
> lock reclaim with holder fencing (RC1/B1), job-file PID reconstruction on corrupt
> recovery (RC2/B6), robust-scan fail-closed stop-gate (RC3/B7, per principal
> decision), Windows crash-recoverable writes via `.bak` (RC4/B8), plus per-uid
> state-dir hardening and broker-session corrupt parity.

---

## 1. Overview

The Codex plugin lets Claude Code delegate reviews and tasks to a Codex runtime,
tracking each as a **job** in a per-workspace `state.json` (`lib/state.mjs`). Jobs
run in the foreground, in the background (`--background`), and as automatic
Stop-hook reviews (`stop-review-gate-hook.mjs`). Multiple OS processes therefore
read and write the same state file concurrently, and long-lived background jobs
mean the file must survive crashes, SIGKILL, and OOM.

Today the state layer (`lib/state.mjs:92-122`) assumes a single, crash-free writer.
It is neither. This PRD specifies the work to make job state **concurrency-safe**
and **crash-safe**, plus four smaller safety/UX fixes surfaced in the same review,
hardened by a second multi-model pass.

## 2. Problem statement

> Background and Stop-gate jobs mutate `state.json` through an unsynchronized
> read-modify-write (`saveState` re-reads `previousJobs` outside any lock,
> `state.mjs:92-93`, then `fs.writeFileSync` non-atomically, `:114`), with a silent
> reset on any corrupt read (`loadState` catch → `defaultState()`, `:75-77`).
> Concurrent writers lose updates; a crash mid-write wipes all job tracking and
> orphans live Codex processes.

Concrete failure modes observed or directly reachable:

- **Lost update (F1):** a background job flips to `completed` at the same moment the
  SessionEnd hook (`session-lifecycle-hook.mjs:52,70`) loads it as `running` and
  rewrites the file without it. The completion record — including the review result
  pointer — is dropped.
- **Silent wipe (F2):** a crash or interleaved write truncates `state.json`;
  `loadState` catches the parse error and returns a fresh empty state, so every
  tracked background PID becomes invisible to `/codex:status` and `/codex:cancel`
  and leaks.
- **Collateral kill (F3):** `/codex:init` cleanup (`~/.claude/skills/codex/init.md`)
  matched and signalled an unrelated **root** process (`earlyoom`) whose command
  line merely contained the string `codex` (its `--avoid` regex).
- **Trapped session (F4):** an unexpected Codex reply blocks the user from ending
  their session (`stop-review-gate-hook.mjs:91-95`), and the block message never
  says how to bypass the gate.

## 3. Goals / Non-goals

### Goals
- **G1.** Concurrent writers to `state.json` never lose each other's job records.
- **G2.** A crash at any point during a state write leaves a readable previous state
  (durable to `fsync` of both the temp file **and** its directory).
- **G3.** A corrupt state file is preserved for diagnosis, not silently discarded;
  orphaned PIDs remain recoverable **and are actually re-surfaced** (reconstructed
  from per-job `jobs/*.json` so `/codex:status` still lists them); concurrent readers
  never observe or race the quarantine.
- **G4.** Process termination only ever targets processes this plugin owns, even
  across PID reuse.
- **G5.** The Stop-gate's failure and bypass paths are discoverable; the gate is
  **fail-closed on any review output lacking an explicit `ALLOW` verdict** — it never
  treats a tokenless or odd-format completed review as approval.
- **G6.** The fragile paths (concurrency, corruption, atomicity, lock reclaim,
  process matching, gate branches) are covered by tests.

### Non-goals
- **N1.** No database, daemon broker for state, or external dependency — stay on the
  filesystem, Node built-ins only.
- **N2.** No change to the job data-model fields or the `state.json` schema shape.
- **N3.** No change to review prompt content or verdict parsing.
- **N4.** No new permanent background process to manage locks.
- **N5.** No guarantee of correctness on networked filesystems (NFS/SMB) where
  `mkdir`/`rename` atomicity is not POSIX-guaranteed — scoped out and documented,
  not silently assumed (see review R11).

## 4. Affected users & flows

| Persona | Flow | Impact today |
|---------|------|--------------|
| Developer running a background review | `/codex:adversarial-review --background` then keeps working | Result silently lost on session end (F1) |
| Developer ending a session | SessionEnd hook cleans up jobs | Concurrent completion lost; running PIDs may leak (F1, F2) |
| Developer after a crash/OOM/SIGKILL | Reopens, runs `/codex:status` | Empty job list; orphan Codex processes untracked (F2); stale lock left behind (R4) |
| Anyone running `/codex:init` | Preflight cleanup | Risk of signalling unrelated / privileged processes (F3) |
| Developer with the gate on | Tries to end session | Can be blocked with no stated escape; odd-but-successful review traps them (F4) |

## 5. Requirements

### Functional

- **FR1 (F1).** All mutations of `state.json` MUST acquire a per-workspace
  cross-process lock and MUST re-read current state **inside** the lock before
  computing the next state. Covers `updateState`, public `saveState`, `setConfig`,
  `upsertJob` (`state.mjs:118-160`), and the SessionEnd hook's direct `saveState`
  read-modify-write (`session-lifecycle-hook.mjs:52,70` — currently an unlocked
  load→filter→save, R2).
- **FR2 (F1).** The lock MUST be released on success, error, and process exit. A
  stale lock (older than a bounded TTL with no live owner) MUST be reclaimable so a
  crashed holder cannot deadlock the workspace. **Reclaim MUST be race-free against
  a second reclaimer AND against a fresh holder (RC1/B1 — the residual 3-process
  TOCTOU v0.2 missed):**
  - Each acquisition writes a **unique owner token** into `owner.json`
    (`{token, pid, host, startedAt}`).
  - A reclaimer MUST NOT `rmSync` the live lock path. It MUST atomically
    `rename(lockDir → <private grave>)` (only one renamer wins; losers get `ENOENT`
    and re-loop), then **verify the grabbed `owner.token` equals the stale token it
    inspected**; on mismatch (a fresh holder acquired in the window) it MUST
    `rename` the dir back and retry, never delete it.
  - Ownership is proven **only** by a subsequent `mkdirSync` succeeding — never by
    the removal.
  - A holder MUST **re-validate its token immediately before committing a write**
    (fencing); if the token is gone/changed it lost the lock to a reclaimer and MUST
    re-acquire (bounded retries) before writing. This guarantees no two writers
    commit even if a reclaim misfires.
- **FR3 (F2).** State and job-file writes MUST be atomic: write to a temp file in
  the same directory, `fsync` the file, `rename` over the target, **and `fsync` the
  containing directory** so the rename survives power loss (R3 — missing dir-fsync).
  The temp file MUST be created with `O_EXCL` (`open(...,'wx')`) so two concurrent
  writers cannot share a temp path (R9). **On platforms whose `rename` cannot
  atomically replace an existing file (Windows), the replace MUST be
  crash-recoverable (RC4/B8):** copy the current target to `<target>.bak` (or hard-link)
  *before* removing it, so a crash between `unlink(target)` and `rename(tmp→target)`
  leaves a recoverable `.bak`; `loadState` MUST recover from `<target>.bak` when the
  target is missing. A bare `unlink`+`rename` with "a small non-atomic window" is NOT
  acceptable — it violates G2 (a crash there leaves no `state.json`).
- **FR4 (F2).** On a corrupt/unparseable state read, the loader MUST move the bad
  file aside (timestamped `*.corrupt-*`) and emit a warning, rather than silently
  returning an empty default. The original bytes MUST be retained. The quarantine
  MUST occur **inside the state lock** so a concurrent writer cannot recreate or
  observe a half-renamed file (R5 — unlocked-reader quarantine race); an unlocked
  `loadState` (e.g. `/codex:status`) MUST NOT perform the rename — it returns default
  and leaves quarantine to the next locked mutation.
  **Recovery MUST be non-destructive of live jobs (RC2/B6 — v0.2 returned empty and
  orphaned PIDs):** before returning, the loader MUST **reconstruct the job list from
  the surviving per-job `jobs/*.json` files** (the redundant source of truth, which
  FR3 also makes atomic), so `/codex:status` and `/codex:cancel` still see live PIDs
  after a corrupt `state.json`. Reconstruction MUST be skipped only when no job files
  parse. A reconstructed-from-corruption state MUST NOT be overwritten by a fresh
  empty save until the job set has been re-materialized (no destructive empty save on
  the corrupt path).
- **FR5 (F3).** Process cleanup MUST match a Codex process by a precise signal
  (executable basename and/or the companion script path and/or a marker env var
  `CODEX_COMPANION_SESSION_ID`), not by substring-matching the full command line, and
  MUST NOT signal processes not owned by the current user (`processUid === currentUid`).
- **FR6 (F4).** When the Stop-gate blocks, the reason MUST include the exact
  bypass command(s). **Verdict detection MUST be robust and fail-closed (RC3/B7 —
  principal decision "robust scan, fail-closed"; supersedes v0.2's fail-open-narrow):**
  the parser MUST scan the **whole** review output (all lines, plus any JSON verdict
  field), not just the first line. Then:
  - a `BLOCK` token anywhere ⇒ **block** (+ bypass command in the reason);
  - **only** an `ALLOW` token and no `BLOCK` ⇒ allow;
  - **neither** token present ⇒ **block** (+ bypass) — a completed-but-tokenless
    review is treated as "no verdict", never as approval.
  This removes the v0.2 regression where a genuine `BLOCK` preceded by a preamble
  line became a false `ALLOW`. Empty / timeout / non-zero exit / invalid JSON still
  block, as before.
- **FR7 (F5).** `terminateProcessTree` MUST treat `EPERM` like `ESRCH` — reported as
  not-delivered with a reason — never an uncaught throw, in **both** the
  process-group and single-process kill branches (`process.mjs:100-118`).
- **FR8 (F7).** `/codex:init` MUST stop using the non-existent effort token `max`
  (`init.md:21-22,202-203`) and MUST actually pass `--effort <level>` to the
  setup/adversarial-review invocations it launches; the companion already exposes
  `--effort none|minimal|low|medium|high|xhigh` (`codex-companion.mjs:69`). Docs and
  runtime MUST agree on the valid token set.

### Functional — added by review (hardening of FR1–FR4)

- **FR9 (R4/R7).** A lock holder killed by SIGKILL/OOM cannot run an `exit` handler;
  recovery MUST therefore rely on the TTL + liveness path (FR2), and the liveness
  check MUST be robust to **PID reuse**: an owner descriptor whose recorded
  `startedAt`/host no longer plausibly matches the live PID MUST be treated as stale
  (a recycled PID number is not proof the original owner lives). Liveness MUST also
  treat `kill(pid,0)`→`EPERM` as "alive" (owned by another user) but combine it with
  the host field so a different machine's PID (shared state dir) is not read as
  local-alive.
- **FR10 (R8).** The synchronous in-lock wait MUST NOT busy-spin. `Atomics.wait` on a
  `SharedArrayBuffer` is the chosen primitive; the implementation MUST verify the
  runtime actually provides `SharedArrayBuffer`/`Atomics.wait` and fall back to a
  bounded `spawnSync` sleep when absent, so the lock works under any runtime the
  plugin is launched with (the plugin currently runs under Node ≥18 via
  `process.execPath`, where both are present; the guard is defence-in-depth).

### Functional — added by reconcile (v0.3)

- **FR11 (RC5).** The lock and temp/state files MUST be safe on a multi-user host
  **via filesystem mode, NOT via path relocation,** and MUST NOT lock other users
  out. Concretely:
  - The **shared** root (the `os.tmpdir()` fallback `codex-companion` dir) MUST be
    created sticky + world-usable (`0o1777`, like `/tmp`) so every uid can create its
    own per-workspace leaf and the sticky bit blocks cross-user deletion. Applying
    `0o700` to the *recursively-created tree* (so it lands on the shared root) is
    forbidden — it causes **broad first-user-wins** (the first user owns the root and
    every other user gets `EACCES` for *any* workspace).
  - Each **per-workspace** dir (and its `jobs/`) MUST be `0o700`, and temp files
    `O_EXCL`, so contents (state, locks, temps) are owner-only and another user cannot
    pre-create or symlink-follow them (CWE-377).
  - The state **path MUST NOT change** from prior versions: any relocation (e.g.
    per-uid namespacing) strands older-version state and cannot be made strand-free
    without a risky live-state migration — out of scope (NFR4). `CLAUDE_PLUGIN_DATA`
    (the normal path) is already per-user and needs no special mode.
  - **Residual limitation (documented):** on a *hostile* multi-user host using the
    shared tmp fallback, a local co-user could pre-create (squat) your workspace leaf
    name; you then get a clean `EACCES`/ownership error, not silent misuse — use
    `CLAUDE_PLUGIN_DATA` to avoid the shared fallback entirely.
- **FR12 (RC6).** `loadBrokerSession` MUST apply the same non-destructive
  corrupt-handling as state (FR4): a corrupt `broker.json` MUST be quarantined +
  warned, not silently `return null`, so a live broker PID is not orphaned without a
  trace (`broker-lifecycle.mjs:82-92`).

### Non-functional

- **NFR1.** No added runtime dependency; Node built-ins only.
- **NFR2.** Lock acquisition overhead < ~25 ms in the uncontended case; **reads do
  not lock** (`/codex:status`, `listJobs`, `getConfig` stay lock-free).
- **NFR3.** Cross-platform: correct on Linux/macOS and Windows. `renameOver` is the
  only platform branch (POSIX atomic replace; Windows `unlink`+`rename` fallback).
  PID-group semantics already branched (`process.mjs:66` taskkill).
- **NFR4.** Backward compatible: existing `state.json` files load unchanged; no
  migration step; lock/`*.corrupt-*`/`*.tmp-*` artifacts are siblings ignored by all
  job readers.
- **NFR5.** All new behavior is unit-testable without a real Codex CLI (existing
  `tests/fake-codex-fixture.mjs` + temp dirs).
- **NFR6 (R11).** On a networked or non-standard filesystem (NFS, SMB, and the WSL2
  DrvFs `/mnt/*` mount) where `mkdir`/`rename` atomicity is not guaranteed, behavior
  is **best-effort and documented**, not claimed-correct. The default state root is
  already under `os.tmpdir()` / `CLAUDE_PLUGIN_DATA` (`state.mjs:10,41-43`), normally
  a local fs; the docs MUST note the caveat for users who relocate it.

## 6. Requirement → finding traceability

| Finding | Severity | Requirements | Workstream |
|---------|----------|--------------|------------|
| F1 lost update | HIGH | FR1, FR2, FR9, FR10 | A — Durability Core |
| F2 silent wipe / non-atomic | HIGH | FR3, FR4 | A — Durability Core |
| F3 collateral kill | MED | FR5 | B — Process Safety |
| F4 trapped session / hidden bypass | MED | FR6 | C — Gate UX |
| F5 EPERM throw | LOW | FR7 | B — Process Safety |
| F6 test gaps | LOW | tests for FR1–FR4, FR7, FR9, FR10 | A/D — Quality |
| F7 effort knob | LOW | FR8 | D — Quality |

### Review-finding traceability (this session)

| ID | Severity | Title | Folds into | Code site |
|----|----------|-------|-----------|-----------|
| R1 | HIGH | Lock-reclaim TOCTOU: two reclaimers both acquire | FR2 | ARCH §3.2 `reclaimIfStale`→`mkdir` |
| R2 | HIGH | SessionEnd unlocked read-modify-write of state | FR1 | `session-lifecycle-hook.mjs:52,70` |
| R3 | MED | Atomic write missing directory `fsync` | FR3 | ARCH §4 `atomicWriteFileSync` |
| R4 | MED | SIGKILL/OOM leaves lock; `exit` handler can't run | FR2, FR9 | ARCH §3.4 |
| R5 | MED | Unlocked-reader quarantine races a writer | FR4 | ARCH §5 `loadState` |
| R6 | MED | Stop-gate fail-open regression (genuine fail mis-allowed) | FR6 | `stop-review-gate-hook.mjs:91` |
| R7 | MED | PID reuse: recycled PID read as live owner | FR9 | ARCH §3.2 `isAlive` |
| R8 | LOW | `Atomics.wait`/SAB assumed present on every runtime | FR10 | ARCH §3.2 `sleepSync` |
| R9 | LOW | Temp file not `O_EXCL`; two writers can collide | FR3 | ARCH §4 tmp path |
| R10 | LOW | Empty/zero-job corrupt recovery hides prior orphans | FR4 | ARCH §5 |
| R11 | LOW | NFS / WSL2 DrvFs atomicity not scoped | NFR6, N5 | `state.mjs:10,41-43` |

### Reconcile traceability (v0.3 — closes the four v0.2 left open)

| ID | Severity | Title | Folds into | Source |
|----|----------|-------|-----------|--------|
| RC1 | HIGH | Lock reclaim residual 3-process TOCTOU; v0.2 `rmSync` could delete a fresh holder's lock | FR2 | GPT-5.4 review + reconcile audit |
| RC2 | HIGH | Corrupt recovery returned empty state → orphan PIDs; needs job-file reconstruction | FR4 | GPT-5.4 + Gemini reviews |
| RC3 | MED | Stop-gate verdict detection brittle (`firstLine`); decision = robust-scan, fail-closed | FR6, G5 | GPT-5.4 review + principal decision |
| RC4 | HIGH | Windows `unlink`+`rename` leaves no `state.json` on crash | FR3 | GPT-5.4 review |
| RC5 | LOW | Shared-tmp state dir not `0o700` / temps not `O_EXCL` (CWE-377). Fixed by mode hardening; path relocation rejected (stranded state, NFR4) | FR11 | Gemini review + stop-gate |
| RC6 | LOW | `loadBrokerSession` silent-null on corrupt (no FR4 parity) | FR12 | Opus 4.8 review |

## 7. Success metrics

- **M1 (FR1).** Concurrency test: N≥20 parallel `upsertJob` children → 0 lost job
  records. *(currently fails / untested)*
- **M2 (FR4).** Corruption test: a truncated `state.json` with intact `jobs/*.json`
  → loader recovers, writes a `*.corrupt-*` backup, and **reconstructs the live job
  list from the job files** so `/codex:status` still lists the PIDs (not zeroed);
  **and** a concurrent reader during quarantine never throws or double-renames (R5).
- **M3 (FR3).** Crash-injection test: kill between temp-write and rename → previous
  state still parses; dir-fsync is invoked (R3, asserted via injected fs). **Windows
  branch (RC4/B8):** kill between `unlink(target)` and `rename` → `loadState` recovers
  from `<target>.bak`, never returns empty.
- **M4 (FR5).** Process-safety test: a process whose argv merely contains `codex`, or
  is owned by another uid, is never selected for termination.
- **M5 (FR6).** Gate test (RC3/B7): a `BLOCK` verdict preceded by a preamble line is
  still **blocked**; output with no verdict token is **blocked**; only a clean `ALLOW`
  (no `BLOCK`) passes; empty/timeout/non-zero/invalid-JSON → blocked; each block
  reason contains a runnable bypass command.
- **M6.** No regression in `npm test`; CI green.
- **M7 (FR2/FR9).** Lock-reclaim test (RC1/B1): two racing mutators against a **dead**
  owner past TTL → exactly one acquires (token + graveyard-rename); a reclaimer that
  renames a **fresh** holder's lock (token mismatch) restores it and does not steal
  ownership; a holder whose token was reclaimed mid-section detects it at the fencing
  check and re-acquires before committing; a reused PID (host/startedAt mismatch) is
  treated as stale (R7).

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Lock held by a crashed process deadlocks the workspace | TTL + liveness on owner PID; auto-reclaim stale (FR2, FR9) |
| Two reclaimers, or a reclaimer vs a fresh holder (RC1/B1) | Reclaim by atomic `rename(lockDir→grave)` (one winner) + token re-verify (restore if a fresh holder was grabbed) + holder fencing before commit; ownership only via `mkdir`. Never `rmSync` the live path |
| SIGKILL/OOM skips `exit` release (R4) | `exit` handler is best-effort only; correctness rests on TTL reclaim, not on graceful release |
| PID reuse marks a stale lock as live (R7) | Owner descriptor carries `{pid, host, startedAt}`; mismatch ⇒ stale |
| Windows `rename` over existing file fails | Platform branch `renameOver`: try rename; on EEXIST/EPERM `unlink`+`rename` |
| Lock adds latency to every status read | Reads never lock; only mutations do |
| Fail-open gate weakens the guarantee (R6) | Only "ran but unparseable, non-empty" fails open; empty/timeout/non-zero/invalid-JSON still block |
| Networked fs breaks `mkdir`/`rename` atomicity (R11) | Documented caveat (NFR6/N5); default root is local tmp |
| Atomics/SAB unavailable on some runtime (R8) | Feature-detect; bounded `spawnSync` sleep fallback |

## 9. Out of scope

Broker transport changes, verdict-schema changes, multi-machine / networked-fs state
sharing (best-effort only), append-only job log + compaction (deferred), and any
harness-side hook-dispatch changes.

## 10. Open questions (resolved during synthesis)

- **OQ1.** Lock primitive: atomic `mkdir` directory-lock vs. `open(..,'wx')`.
  **Resolved:** `mkdir` directory-lock — atomic on all target platforms, and the
  owner descriptor lives naturally as a file inside it. (See ARCH §11.)
- **OQ2.** Should SessionEnd cleanup adopt the atomic backup-on-corrupt path?
  **Resolved:** yes — it now routes through the locked `saveState`/`loadState`
  (R2/FR1), but MUST never block shutdown (catch-and-warn).
- **OQ3.** F3 lives in PAI `init.md`, outside this repo. **Resolved:** fix in both —
  ship the precise matcher + uid guard as a documented pattern here (a pure,
  unit-tested predicate in `lib/process.mjs`) and update `init.md` to use it.
- **OQ4.** F7/effort default for `/codex:init`'s launched commands. **Resolved:**
  default to `xhigh` (matches this run's max-effort directive); note the slower
  stop-gate trade-off in the doc.

---

## 11. Version History

| Version | Date | Editor | Status | Changes |
|---------|------|--------|--------|---------|
| v0.1-proposal | 2026-06 | proposal-pack | superseded | Original 7-finding pack (F1–F7); PRD/ARCH/PLAN drafted from a live `/codex:init` + adversarial-review session against `807e03a`. |
| v0.2-claude-merge | 2026-06-12 | claude-merge | superseded | Folded 11 multi-model review findings (R1–R11) from Opus 4.8 + GPT-5.5-xhigh (max effort). Added FR9 (PID-reuse/SIGKILL reclaim), FR10 (Atomics feature-detect), NFR6 + N5 (networked-fs scoping). Hardened FR1 (SessionEnd locked RMW), FR2 (TOCTOU-safe reclaim), FR3 (dir-fsync + O_EXCL temp), FR4 (locked-only quarantine), FR6 (narrowed fail-open). Added metric M7. |
| v0.3.1-rc5-revise | 2026-06-13 | claude | canonical | Stop-gate review (3 rounds) showed per-uid path relocation cannot be made strand-free (NFR4). RC5/FR11 revised to **mode-based hardening only** (`0o700` dir + `O_EXCL` temps); path relocation dropped. Implemented in the durability unit. |
| v0.3-reconcile | 2026-06-13 | claude-reconcile | superseded | Reconcile pass vs the unanimous 3-model blocker list (incl. the GPT-5.4 review that postdated v0.2). Closed 4 open/over-claimed items: FR2 token + graveyard-rename reclaim with holder fencing (RC1/B1), FR4 job-file PID reconstruction on corrupt (RC2/B6), FR6 robust-scan fail-closed gate per principal decision (RC3/B7), FR3 Windows `.bak` crash-recovery (RC4/B8). Added FR11 (per-uid/`0o700` shared-tmp hardening, RC5), FR12 (broker corrupt parity, RC6). Updated G3/G5, M2/M3/M5/M7, added Windows crash + reconstruction assertions. |
