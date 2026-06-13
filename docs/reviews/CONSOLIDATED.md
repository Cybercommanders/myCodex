# Consolidated Review — Codex Plugin Durability & Safety

**PRD under review:** v0.1 (proposal) → v0.2-claude-merge (canonical)
**Base commit:** `807e03a` · **Window:** 2026-06
**Reviewer lineup (this run):**

| Channel | Model | Effort | Status | Notes |
|---------|-------|--------|--------|-------|
| Claude (native) | Opus 4.8 | max | ✅ captured | reviewer override per run config |
| Codex CLI | GPT-5.5-xhigh | xhigh | ✅ folded (pre-gathered) | findings supplied with the task |
| Claude Fable 5 | — | — | ⛔ OFF | disabled per run config |
| ChatGPT (Proxima) | gpt-5.5-pro | — | ⏭️ skipped | Proxima providers logged out; web dispatch unavailable this run |
| Gemini (Proxima) | gemini-3.1-pro | — | ⏭️ skipped | same |
| Grok (Proxima) | grok | — | ⏭️ skipped | same — and there is no Grok ideation chat for this source (proposal-sourced run) |

> **Degraded-lineup note (per autonomy contract):** the source for this run was a
> finished proposal pack plus already-gathered multi-model findings — not a fresh
> Grok ideation chat. Proxima's three web channels were logged out
> (`~/.config/proxima/settings.json` → all providers `loggedIn:false`), so no live
> web dispatch was performed. The two native/CLI channels (Opus 4.8, GPT-5.5-xhigh)
> plus the pre-gathered findings form the effective panel. This is the documented
> 2-channel floor, not a halt.

---

## How the merge was done

Default **patch mode**: reviewers returned severity-graded findings + section-scoped
patches, not full PRD rewrites. The 11 findings below were merged into v0.2 as new
requirements (FR9, FR10, NFR6, N5) and as tightened obligations on the existing
FR1–FR6. No finding overturned an original requirement; every one **hardened a
correctness edge** the original prose left implicit.

## Agreement map

All 11 findings below were either single-source-high-confidence (verified against
code) or corroborated across the Opus 4.8 and GPT-5.5-xhigh passes. Each was
**cross-checked against the actual source** in this repo before acceptance — see the
"Verified" column. No fact arbitration pass was needed (no reviewer disagreed on a
checkable fact); the one runtime-version question (R8, Atomics/SAB availability) was
settled by direct check: `node -e` confirmed both present on the Node v24 runtime the
plugin uses via `process.execPath`.

| ID | Sev | Finding | Verified against code | Resolution in v0.2 |
|----|-----|---------|----------------------|--------------------|
| R1 | HIGH | **Lock-reclaim TOCTOU.** `reclaimIfStale` does `rmSync(lockDir)` then `continue`s to re-`mkdir`; two processes can both pass the staleness check, both `rmSync`, and both `mkdir` in an order that lets each think it won. | ARCH §3.2 sketch (`reclaimIfStale`/`acquireStateLock` loop) | FR2 tightened: ownership derives **only** from a successful `mkdirSync`, never from the `rmSync`; losers see `EEXIST` and loop. M7 added. |
| R2 | HIGH | **SessionEnd unlocked RMW.** `cleanupSessionJobs` does `loadState`→filter→`saveState` with no lock around the pair; a background job completing between the load and save is dropped — the exact F1 race on the shutdown path. | `session-lifecycle-hook.mjs:52,70` (confirmed: bare `loadState` then `saveState`) | FR1 explicitly lists the SessionEnd hook; OQ2 resolved — route through locked `saveState`, never block shutdown. |
| R3 | MED | **Missing dir-fsync.** `atomicWriteFileSync` fsyncs the temp file then renames, but never fsyncs the **directory**, so on power loss the rename can be lost even though the data was synced. | ARCH §4 sketch (no `opendir`/`fsync` of dir) | FR3 now requires fsync of the containing directory after rename. M3 asserts it. |
| R4 | MED | **SIGKILL/OOM lock leak.** Release is wired to `process.on('exit')`, which does **not** run on SIGKILL or OOM-kill — precisely the crash classes this work targets. | ARCH §3.4 ("`process.on('exit')` for the common case") | FR9: correctness rests on TTL reclaim, not graceful release; `exit` handler is best-effort only. |
| R5 | MED | **Unlocked-reader quarantine race.** `loadState` is called both inside the lock (mutations) and outside it (`/codex:status`, gate). The FR4 rename-aside runs in `loadState`, so an unlocked reader can rename `state.json` out from under a concurrent locked writer. | `state.mjs:58-78` + unlocked callers (`listJobs:149`, `getConfig:162`, used by `stop-review-gate-hook.mjs:11,148` and `/codex:status`) | FR4 split: quarantine only inside the lock; unlocked `loadState` returns default without renaming. |
| R6 | MED | **Stop-gate fail-open regression.** FR6's "ran but unparseable ⇒ allow" risks misclassifying a genuine failure (e.g. a crash that still prints a banner) as a benign odd review, silently weakening the gate from fail-closed to fail-open. | `stop-review-gate-hook.mjs:69-96,112-139` (empty/timeout/non-zero/invalid-JSON branches must stay blocking) | FR6 narrowed: only non-empty, recognized-as-review-but-odd output fails open; the four failure branches stay blocking. M5 asserts both directions. |
| R7 | MED | **PID reuse.** `isAlive(pid)` via `kill(pid,0)` returns true if **any** process now holds that PID number — after the original owner died and the OS recycled the PID, the lock looks live forever. | ARCH §3.2 `isAlive` sketch (no host/startedAt corroboration) | FR9: owner descriptor `{pid, host, startedAt}`; a live PID whose host/startedAt don't match is treated as stale. |
| R8 | LOW | **Atomics.wait/SAB assumption.** `sleepSync` assumes `SharedArrayBuffer`+`Atomics.wait` exist on every runtime; flagged as a risk if ever launched under a runtime lacking them (e.g. some Bun/embedder configs). | Verified present on this plugin's runtime: `node v24.12.0`, `typeof SharedArrayBuffer==='function'`, `typeof Atomics.wait==='function'`. Plugin launches children via `process.execPath` (Node), so SAB is available. | FR10: feature-detect; bounded `spawnSync` sleep fallback. Low risk in practice, guarded for defence-in-depth. |
| R9 | LOW | **Temp file not O_EXCL.** The atomic-write temp path uses `pid+rand`; without `O_EXCL`, an astronomically-unlikely collision (or a leftover temp from a prior crash) could be opened+truncated by two writers. | ARCH §4 `fs.openSync(tmp,"w")` (mode `"w"`, not `"wx"`) | FR3: create the temp with `O_EXCL` (`"wx"`) / collision-proof unique name. |
| R10 | LOW | **Empty corrupt-recovery hides orphans.** FR4 returns an empty default after quarantine; if the corrupt file held running-job PIDs, `/codex:status` shows nothing and the operator has no in-product pointer to the orphans. | ARCH §5 (returns `defaultState()` only) | FR4 keeps the `*.corrupt-*` bytes and the warning names the backup path; a future `/codex:status --recover` is noted (not in scope, but the bytes are retained so it's possible). |
| R11 | LOW | **NFS / WSL2 DrvFs scoping.** `mkdir`/`rename` atomicity isn't POSIX-guaranteed on NFS/SMB or the WSL2 `/mnt/*` DrvFs mount; the PRD claimed cross-platform correctness without scoping the fs. | `state.mjs:10` (`os.tmpdir()`), `:41-43` (`CLAUDE_PLUGIN_DATA`) — default root is local tmp; only at risk if a user relocates it onto a network mount. | NFR6 + N5: best-effort + documented on networked/DrvFs; not claimed-correct. |

## Severity rollup

- **HIGH (2):** R1 (lock TOCTOU), R2 (SessionEnd unlocked RMW) — both are correctness
  holes in the very mechanism the proposal introduces; must be fixed in Phase 1/2 or
  the lock provides a false sense of safety.
- **MED (5):** R3, R4, R5, R6, R7 — durability/UX edges that turn the "fixed" code
  back into a subtle version of the original bug under crash/concurrency.
- **LOW (4):** R8, R9, R10, R11 — defence-in-depth and scoping; cheap to honor.

## Net change to the plan

No phase is removed; the existing P1–P5 sequencing holds. The merge adds these
**must-do-in-phase** obligations:

- **P1 (lock):** R1 (reclaim ownership from `mkdir` only), R2 (SessionEnd through the
  lock), R4 + R7 (TTL/host/startedAt staleness, not graceful release), R8 (Atomics
  feature-detect). New test: M7.
- **P2 (atomic write + recovery):** R3 (dir-fsync), R9 (O_EXCL temp), R5 (quarantine
  only under lock), R10 (retain bytes). M2/M3 extended.
- **P4 (gate):** R6 (narrow the fail-open branch; keep four failure branches
  blocking). M5 extended to assert both directions.
- **Docs:** R11 (NFS/DrvFs caveat in ARCHITECTURE §7 + adapter notes).
