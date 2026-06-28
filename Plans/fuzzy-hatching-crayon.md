# Plan — Stop hanging Codex procs + fix empty structured reviews

## Context

`codex-plugin-cc` drives the Codex CLI from Claude Code for background reviews/rescue. Two
recurring pain points:

1. **Hanging procs / long blocks** (the "420s/7-min" symptom). The hangs are *not* one bad
   timeout knob — they come from three unbounded-or-too-long primitives plus missing cleanup
   guards that leave orphan codex/broker processes (the MCP-leak / zombie history).
2. **Empty structured `/codex:review` output** — reviews return `parseError = "Codex did not
   return a final structured message."`, verdict stuck at `needs-attention`, no findings.
   Separately tracked in `Plans/fix-empty-structured-review.md`; folded in here as Workstream B.

These compound: an empty review returns `needs-attention`, and the stop-gate then **blocks
Claude from stopping for up to 15 min** — worst case is a useless review that also holds the
session hostage. Fixing both makes review either succeed fast or fail fast, never hang.

Intended outcome: every wait has an upper bound; on timeout the system fails fast + retryable;
no orphan codex/broker procs survive a session; structured reviews return real parsed JSON.

User decisions: **Full scope** (bound waits + fix orphans + broker idle-exit). Stop-gate default
set to **lower + non-blocking** (recommended) — see A6; veto at approval if you want it kept blocking.

---

## Diagnosis (evidence)

| # | Unbounded / unsafe primitive | Location | Effect |
|---|---|---|---|
| 1 | IPC `request()` promise — no timeout | `lib/app-server.mjs:86-98` | stalled codex turn ⇒ hang forever |
| 1b| broker's interior `appClient.request()` — no timeout | `scripts/app-server-broker.mjs:201` | same; also busy-locks the single-slot broker |
| 1c| socket `connect` — no timeout | `lib/app-server.mjs:285` | dead socket file ⇒ client hangs on connect |
| 2 | `spawnSync` — no `timeout` | `lib/process.mjs:5` | any binary check / git / taskkill can block forever |
| 3 | stop-gate ceiling 15 min, **blocks** on timeout | `stop-review-gate-hook.mjs:16,112-117,166-172` | holds Claude open up to 15 min |
| 4 | SessionEnd has no `try/finally` | `session-lifecycle-hook.mjs:99-111` | broker-shutdown throw skips job reaping ⇒ orphans |
| 5 | `terminateProcessTree` SIGTERM only, no SIGKILL | `lib/process.mjs:100-117` | procs ignoring SIGTERM survive |
| 6 | broker never self-exits when idle | `app-server-broker.mjs` (no idle timer) | orphan broker accumulation; permanent busy-lock |
| 7 | structured output dropped on capture | `lib/codex.mjs:414-422` (`recordItem`), `339-357` (`completeTurn`), `1018` | empty `finalMessage` ⇒ empty review |

Already-correct bounds (leave as-is): status poll 240s (`codex-companion.mjs:67`), state lock
10s→throw (`lib/state.mjs:235-251`), broker readiness 2000ms / liveness 150ms
(`broker-lifecycle.mjs:26,107`), completion timer 250ms unref'd (`codex.mjs:376-386`).

---

## Workstream A — stop the hangs & orphans

Default timeout values (all env-overridable; pick conservative, real fix is "bounded at all"):

| Knob | Default | Env override |
|---|---|---|
| IPC request | 120_000 ms | `CODEX_APP_SERVER_REQUEST_TIMEOUT_MS` |
| socket connect | 5_000 ms | `CODEX_APP_SERVER_CONNECT_TIMEOUT_MS` |
| `runCommand` spawnSync | 60_000 ms (per-call override) | n/a (caller passes `timeoutMs`) |
| SIGTERM→SIGKILL grace | 3_000 ms | n/a |
| broker idle self-exit | 600_000 ms | `CODEX_BROKER_IDLE_TIMEOUT_MS` |

**A1 — Bound IPC `request()` + socket connect.** In `AppServerClientBase.request()`
(`lib/app-server.mjs:86`), wrap the pending promise with a `setTimeout` that, on fire, deletes
the entry from `this.pending` and rejects with a `createProtocolError("… request timed out")`;
`.unref()` the timer; clear it in `handleLine` resolve/reject and `handleExit`. Add
`socket.setTimeout(connectMs)` + `'timeout'` handler in both `initialize()` paths
(`SpawnedCodexAppServerClient` ~`:189`, `BrokerCodexAppServerClient` ~`:282`). Because the broker
reuses this same client class, A1 also bounds 1b at `app-server-broker.mjs:201` (the broker's
turn now rejects instead of busy-locking). *Test:* `tests/runtime.test.mjs`-style — a fake
transport that never replies ⇒ `request()` rejects within the timeout (inject a short timeout).

**A2 — Bound `spawnSync`.** In `runCommand` (`lib/process.mjs:5`) add
`timeout: options.timeoutMs ?? 60_000` and `killSignal: "SIGKILL"` to the options object.
spawnSync natively kills the child + returns `error.code === "ETIMEDOUT"`; `runCommandChecked`
already throws on `result.error`. Callers (`binaryAvailable`, git ops, taskkill) inherit the
bound; pass a larger `timeoutMs` where legitimately long. *Test:* inject a sleep command (or a
fake) and assert `ETIMEDOUT` surfaces.

**A3 — SIGKILL escalation in `terminateProcessTree`** (`lib/process.mjs:100-117`). After the
SIGTERM (group, then single), schedule an `unref`'d follow-up that sends
`killImpl(-pid,"SIGKILL")` (then single) after the grace window, swallowing `ESRCH`/`EPERM` per
the contract. **Extends `specs/001-codex-durability-safety/contracts/process-safety.contract.md:18`**
— update that line additively (SIGTERM, then SIGKILL after grace; still never throws on
EPERM/ESRCH). *Test:* mirror existing `process.test.mjs` injected `killImpl` — assert SIGKILL
issued when the proc is still alive after grace, and EPERM/ESRCH still returns `delivered:false`.

**A4 — Guarantee SessionEnd cleanup** (`session-lifecycle-hook.mjs:81-112`). Wrap
`sendBrokerShutdown` in `try/catch`, and move `cleanupSessionJobs` + `teardownBrokerSession` +
`clearBrokerSession` into a `finally` so a broker-shutdown failure can never skip job reaping.
*Test:* `tests/commands.test.mjs`-style — stub `sendBrokerShutdown` to throw, assert
`terminateProcessTree` still called for running jobs.

**A5 — Broker idle self-exit + turn bound** (`app-server-broker.mjs`). Add an `unref`'d idle
timer reset on every inbound message; on fire, graceful `shutdown(server)` + `process.exit(0)`.
The per-turn bound is already delivered by A1 (broker uses the bounded client), so a stuck turn
rejects and frees the slot instead of busy-locking permanently. *Test:* a focused unit test that
the idle timer fires `shutdown` after the configured idle window (inject a short window + fake
clock/`server`).

**A6 — Stop-gate: lower + non-blocking** (`stop-review-gate-hook.mjs`). Set ceiling default
`STOP_REVIEW_TIMEOUT_MS = Number(env.CODEX_STOP_REVIEW_TIMEOUT_MS) || 5*60_000` (line 16) and sync
`hooks.json:31` `"timeout"` to 360 (ceiling + margin). On `ETIMEDOUT` (lines 112-117), emit
`{decision:"allow"}` with a warning reason instead of `block` (lines 166-172) so a stuck codex
review never holds the session — review still runs, just can't hold Stop hostage. *Test:* extend
the stop-gate test to assert timeout ⇒ allow+warn, not block.

---

## Workstream B — fix empty structured review

Fold `Plans/fix-empty-structured-review.md` (independent of A; different files). Discipline: TDD,
verify against the **real** codex-cli, not just the fake fixture.

**B1 — Identify the real channel first (no guessing).** Inspect the present generated types in
`plugins/codex/.generated/app-server-types/` (`AgentMessageInputContent.ts`, `ResponseItem`/item
union, plus the review-mode items — note `recordItem` already has an `exitedReviewMode` branch at
`codex.mjs:442`). Then live-capture: temporary raw dump in the notification handler
(`codex.mjs:556`) logging `message.method` + `item.type` + keys, run ONE real `/codex:review`
with `outputSchema` (`codex-companion.mjs:412`), find where the schema'd JSON actually arrives.
Record it as a checked-in fixture (the RED input). Likely: structured **content field** of
`agentMessage` (not `.text`), a **new item type** at `item/completed`, or the **`turn` object** on
`turn/completed` (already received at `codex.mjs:545`, never mined).

**B2 — RED test.** Update `tests/fake-codex-fixture.mjs:432` so the structured-review path emits
the **real** shape from B1 (keep the old `agentMessage.text` path too — no regression). Add a test
(`tests/structured-output.test.mjs`) asserting a structured review yields non-empty `finalMessage`
that `parseStructuredOutput` parses to `{verdict, summary, findings…}`. Must fail today.

**B3 — GREEN (smallest change matching B1).** Keep `agentMessage.text` as primary; add the new
channel as fallback:
- content-field ⇒ in `recordItem` (`codex.mjs:414`), when `item.text` empty derive text from
  structured content before setting `lastAgentMessage`;
- new item type ⇒ new `recordItem` branch into `lastAgentMessage` (or `finalStructured` surfaced
  via `runTask`→`finalMessage` at `:1018`);
- on the turn object ⇒ in `completeTurn` (`codex.mjs:347`) extract final output into
  `lastAgentMessage` when no agentMessage text was seen.

**B4 — Live verify.** Real `/codex:review` on a small diff ⇒ parsed JSON, real verdict, non-empty
findings, `parseError === null`. A passing fake alone does NOT close this.

---

## Sequencing

1. **A1, A2** first (highest leverage — converts "hang forever" → "fail fast"; small, isolated).
2. **A3, A4** (orphan reaping; A3 updates the process-safety contract).
3. **A5** (broker idle-exit), **A6** (stop-gate behavior).
4. **B** in parallel/after (separate files: `codex.mjs`, fixture, new test) — needs the live
   codex-cli capture in B1 before coding.

Files touched: `lib/process.mjs`, `lib/app-server.mjs`, `app-server-broker.mjs`,
`session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, `hooks/hooks.json`,
`contracts/process-safety.contract.md` (A); `lib/codex.mjs`, `tests/fake-codex-fixture.mjs`,
`tests/structured-output.test.mjs` (B).

## Scope guards

- Conservative default timeouts; the win is "bounded at all," not aggressive values. All
  env-overridable.
- Keep both old + new CLI emission shapes (B). Don't redesign the review prompt/schema, the
  broker retry path, or the codegraph-MCP stall (separate issue).
- Don't print captured secrets/prompts in test failure output.

## Verification

- `npm test` green — existing 8 suites + new tests for A1, A2, A3, A4, A5, A6, B.
- `npm run lint` clean.
- **Hang proof:** with a fake/stub transport that never replies, `/codex:review --wait` rejects
  within the request timeout (not 15 min); SessionEnd with a throwing broker-shutdown still reaps
  running jobs (assert `terminateProcessTree` called); after a session, no orphan
  `codex`/`app-server-broker` procs (`pgrep -f codex-companion`, broker pidfile gone).
- **Review proof (required):** real `/codex:review` on a small diff ⇒ parsed JSON + real verdict +
  non-empty findings + `parseError === null`; paste evidence in PR.
- Bump per `npm run bump-version`; note both fixes in changelog/PR.

---

## Outcome (implemented 2026-06-27)

**Workstream A — SHIPPED.** A1–A6 all implemented + unit-tested (TDD red→green), 11 new
passing tests, zero regressions (verified by stashing source and re-running per-file baselines;
failure count went 9→8 on runtime.test.mjs — one *fewer*). Lint: 0 errors.

- A1 `lib/app-server.mjs` — `request()` bounded (`CODEX_APP_SERVER_REQUEST_TIMEOUT_MS`, 120s),
  socket connect bounded (`CODEX_APP_SERVER_CONNECT_TIMEOUT_MS`, 5s); failed handshake destroys
  transport. Tests: `tests/app-server-timeout.test.mjs`.
- A2 `lib/process.mjs` — `runCommand` `spawnSync` gets `timeout` (60s default, per-call
  `timeoutMs`) + `killSignal:"SIGKILL"`. Test in `tests/process.test.mjs`.
- A3 `lib/process.mjs` — SIGTERM→SIGKILL escalation (3s grace, injectable `scheduleImpl`),
  liveness-probed, never throws. Contract updated. Tests in `tests/process.test.mjs`.
- A4 `session-lifecycle-hook.mjs` — `handleSessionEnd` exported + injectable; broker shutdown
  in try/catch, reaping in `finally`. Direct-invocation guard added. Test:
  `tests/session-lifecycle.test.mjs`.
- A5 `app-server-broker.mjs` — `createIdleWatchdog` (exported), idle self-exit
  (`CODEX_BROKER_IDLE_TIMEOUT_MS`, 600s), armed per message. Direct-invocation guard added.
  Test: `tests/broker-idle.test.mjs`.
- A6 `stop-review-gate-hook.mjs` + `hooks.json` — ceiling 5m (`CODEX_STOP_REVIEW_TIMEOUT_MS`),
  hooks.json timeout 900→360, timeout now ALLOWS stop (`decideStop`, exported). Test:
  `tests/stop-review-gate.test.mjs`.

**Workstream B — NOT REPRODUCIBLE on codex-cli 0.142.3; no code shipped.** Two faithful live
captures (trivial `outputSchema`, and the real `schemas/review-output.schema.json` against a real
diff) both returned fully-parsed structured JSON (`verdict`, `summary`, `findings`),
`parseError === null`, `finalMessage` populated. The plan's mandated RED capture instead came back
green, so no speculative fix was made (ponytail: no fix for an unreproducible bug; the plan itself
forbids guessing). The structured-turn capture path (`recordItem` setting `lastAgentMessage` from
the final `agentMessage`) works end-to-end in 0.142.3. Re-open only if a real failing capture
surfaces on a specific CLI version/diff; the fix at that point is to mine the final message from
`turn.items` in `completeTurn` (`codex.mjs`) — but note `turn.items` was empty (`itemsView:summary`)
in both captures, so today it would be a no-op.

**Pre-existing failures (NOT introduced here):** `runtime.test.mjs` setup tests (fake-codex
fixture / app-server readiness in this env), `status`/`result` tests, `state.test.mjs`
`resolveStateDir` (temp-dir detection), `commands.test.mjs` `continue`. All fail identically on
clean HEAD with my changes stashed.
