# PRD — Codex Plugin Durability & Safety

**Status:** Draft for review · **Base commit:** `807e03a` · **Related:** [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`PLAN.md`](./PLAN.md)

---

## 1. Overview

The Codex plugin lets Claude Code delegate reviews and tasks to a Codex runtime,
tracking each as a **job** in a per-workspace `state.json`. Jobs run in the
foreground, in the background, and as automatic Stop-hook reviews. Multiple
processes therefore read and write the same state file concurrently, and
long-lived background jobs mean the file must survive crashes.

Today the state layer assumes a single, crash-free writer. It is neither. This
PRD specifies the work to make job state **concurrency-safe** and **crash-safe**,
plus four smaller safety/UX fixes surfaced in the same review.

## 2. Problem statement

> Background and Stop-gate jobs mutate `state.json` through an unsynchronized
> read-modify-write, with non-atomic writes and a silent reset on any corrupt
> read. Concurrent writers lose updates; a crash mid-write wipes all job
> tracking and orphans live Codex processes.

Concrete failure modes observed or directly reachable:

- **Lost update (F1):** a background job flips to `completed` at the same moment
  the SessionEnd hook loads it as `running` and rewrites the file without it. The
  completion record — including the review result pointer — is dropped.
- **Silent wipe (F2):** a crash or interleaved write truncates `state.json`;
  `loadState` catches the JSON parse error and returns a fresh empty state, so
  every tracked background PID becomes invisible to `/codex:status` and
  `/codex:cancel` and leaks.
- **Collateral kill (F3):** `/codex:init` cleanup matched and signalled an
  unrelated root process whose command line merely contained the string `codex`.
- **Trapped session (F4):** an unexpected Codex reply blocks the user from ending
  their session, and the block message never says how to bypass the gate.

## 3. Goals / Non-goals

### Goals
- G1. Concurrent writers to `state.json` never lose each other's job records.
- G2. A crash at any point during a state write leaves a readable previous state.
- G3. A corrupt state file is preserved for diagnosis, not silently discarded;
  orphaned PIDs remain recoverable.
- G4. Process termination only ever targets processes this plugin owns.
- G5. The Stop-gate's failure and bypass paths are discoverable and not a dead end.
- G6. The fragile paths (concurrency, corruption, atomicity) are covered by tests.

### Non-goals
- N1. No database, daemon broker for state, or external dependency — stay on the
  filesystem.
- N2. No change to the job data model fields or the `state.json` schema shape.
- N3. No change to review prompt content or verdict parsing.
- N4. No new permanent background process to manage locks.

## 4. Affected users & flows

| Persona | Flow | Impact today |
|---------|------|--------------|
| Developer running a background review | `/codex:adversarial-review --background` then keeps working | Result can be silently lost on session end (F1) |
| Developer ending a session | SessionEnd hook cleans up jobs | Concurrent completion lost; running PIDs may leak (F1, F2) |
| Developer after a crash/OOM | Reopens, runs `/codex:status` | Sees empty job list; orphan Codex processes untracked (F2) |
| Anyone running `/codex:init` | Preflight cleanup | Risk of signalling unrelated processes (F3) |
| Developer with the gate on | Tries to end session | Can be blocked with no stated escape (F4) |

## 5. Requirements

### Functional

- **FR1 (F1).** All mutations of `state.json` MUST acquire a per-workspace
  cross-process lock, and MUST re-read current state inside the lock before
  computing the next state. Covers `updateState`, `saveState`, `setConfig`,
  `upsertJob`, and the SessionEnd hook's direct `saveState`.
- **FR2 (F1).** The lock MUST be released on success, error, and process exit,
  and a stale lock (older than a bounded TTL with no live owner) MUST be
  reclaimable so a crashed holder cannot deadlock the workspace.
- **FR3 (F2).** State and job-file writes MUST be atomic: write to a temp file in
  the same directory, fsync, then rename over the target.
- **FR4 (F2).** On a corrupt/unparseable state read, the loader MUST move the bad
  file aside (timestamped) and emit a warning, rather than silently returning an
  empty default. The recovered state MAY be empty, but the original bytes MUST be
  retained.
- **FR5 (F3).** Process cleanup MUST match a Codex process by a precise signal
  (executable basename and/or the companion script path / a marker env var), not
  by substring-matching the full command line, and MUST NOT signal processes not
  owned by the current user.
- **FR6 (F4).** When the Stop-gate blocks, the reason MUST include the exact
  bypass command(s). A review that *ran but returned an unrecognized format* MUST
  be treated as non-blocking with a warning, distinct from a review that failed to
  run.
- **FR7 (F5).** `terminateProcessTree` MUST treat `EPERM` like `ESRCH` —
  reported as not-delivered with a reason — never an uncaught throw.
- **FR8 (F7).** The companion already exposes `--effort` (`none|minimal|low|medium|high|xhigh`,
  `codex-companion.mjs:69`). `/codex:init` MUST (a) stop using the non-existent
  token `max`, and (b) actually pass `--effort xhigh` (or its chosen level) to the
  setup/adversarial-review invocations it launches, so the promised effort is
  honored. Docs and runtime MUST agree on the valid token set.

### Non-functional

- **NFR1.** No added runtime dependency; Node built-ins only.
- **NFR2.** Lock acquisition overhead < ~25 ms in the uncontended case.
- **NFR3.** Cross-platform: correct on Linux/macOS and Windows (rename-over-exist
  and PID-group semantics differ — see ARCHITECTURE §7).
- **NFR4.** Backward compatible: existing `state.json` files load unchanged; no
  migration step.
- **NFR5.** All new behavior is unit-testable without a real Codex CLI (use the
  existing fake-codex fixture and temp dirs).

## 6. Requirement → finding traceability

| Finding | Requirements | Workstream | Severity |
|---------|--------------|------------|----------|
| F1 | FR1, FR2 | A | HIGH |
| F2 | FR3, FR4 | A | HIGH |
| F3 | FR5 | B | MED |
| F4 | FR6 | C | MED |
| F5 | FR7 | B | LOW |
| F6 | (tests for FR1–FR4, FR7) | A/D | LOW |
| F7 | FR8 | D | LOW |

## 7. Success metrics

- M1. Concurrency test: N≥20 parallel `upsertJob` children → 0 lost job records
  (currently fails / untested).
- M2. Corruption test: a truncated `state.json` → loader recovers, writes a
  `*.corrupt-*` backup, job list is not silently zeroed.
- M3. Crash-injection test: kill between temp-write and rename → previous state
  still parses.
- M4. Process-safety test: a process whose argv merely contains `codex` is never
  selected for termination.
- M5. Gate test: unrecognized-but-present review output → session not blocked;
  blocked reason string contains a runnable bypass command.
- M6. No regression in the existing `npm test` suite; CI green.

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Lock held by a crashed process deadlocks the workspace | TTL + liveness check on the lock owner PID; auto-reclaim stale (FR2) |
| Windows `rename` over an existing file fails | Platform branch: `unlink`+`rename` or `copyFile`+`unlink` (ARCH §7) |
| Lock adds latency to every status read | Reads do NOT lock; only mutations do (status is read-only) |
| Over-aggressive process matching still misses a real orphan | Keep tracked-PID teardown as the primary path; matcher is a backstop only |
| Fail-open gate weakens the guarantee | Only "ran but unparseable" fails open; "failed to run" / timeout still block |

## 9. Out of scope

Broker transport changes, verdict-schema changes, multi-machine state sharing,
and any harness-side hook dispatch changes.

## 10. Open questions

- OQ1. Lock primitive: atomic `mkdir` directory-lock vs. `open(..., 'wx')`
  lockfile? (ARCHITECTURE recommends `mkdir`; confirm Windows behavior.)
- OQ2. Should the SessionEnd cleanup also adopt the atomic backup-on-corrupt path,
  or fail silent during shutdown? (Proposed: same path, but never block shutdown.)
- OQ3. F3 lives in the PAI `init.md` skill, outside this repo. Fix here as a
  documented pattern, in the skill, or both?
- OQ4. F7/effort: the `--effort` knob already exists — should `/codex:init`
  default its launched commands to `xhigh` or `high`? (Higher = slower stop-gate.)
