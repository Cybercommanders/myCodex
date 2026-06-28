# Fix: empty structured `/codex:review` output ("Codex did not return a final structured message")

**Status:** ready for implementation (handoff). **Repo:** `~/dev/codex-plugin-cc`. **Branch:** cut from current `feat/codex-durability-safety-prd` (or main) — your call.
**Author of plan:** explore-session analysis, 2026-06-28. **Implementer:** another agent.
**Discipline:** TDD (red → green), verify against the REAL codex-cli, not just the fake fixture.

---

## 1. Symptom (what users see)

`/codex:review` and the stop-time review gate return an **empty / unparseable structured result**: `parseError = "Codex did not return a final structured message."`, verdict stuck at `needs-attention`, findings empty. Recurs across codex-cli 0.140 → 0.142; **not** fixed by version bumps. (Separate, out-of-scope issue: review *hangs* on `codegraph_explore` MCP stalls — different failure mode, do not conflate.)

## 2. Root cause (confirmed by code; one unknown to verify first)

Data flow:
- `recordItem()` sets `state.lastAgentMessage` **only** from `item.type === "agentMessage"` with `item.text`.
  `plugins/codex/scripts/lib/codex.mjs:414-422`
- `completeTurn()` stores the entire `turn` object as `state.finalTurn` but **never extracts any final message/output from it**.
  `codex.mjs:339-357`
- `runTask()` returns `finalMessage: turnState.lastAgentMessage`.
  `codex.mjs:1018`
- The review command feeds that to `parseStructuredOutput(result.finalMessage, …)`; empty ⇒ the "did not return" error.
  `codex-companion.mjs:415`, `codex.mjs:1056-1064`

**The bug:** when a turn is started with `outputSchema` (structured review — `codex-companion.mjs:412`), codex-cli ≥0.140 delivers the schema'd JSON through a channel that is **not** an `item.type==="agentMessage"` with `.text`. That channel is currently dropped, so `lastAgentMessage` stays `""`.

**Why the test suite is green anyway (the trap):** the fake fixture emits structured output as a plain agent message —
`tests/fake-codex-fixture.mjs:432` → `item: { type: "agentMessage", id: "msg_"+turnId, text: payload, phase: "final_answer" }`.
`recordItem` captures that, so tests pass. **The fake models OLD behavior; the real CLI doesn't.** This is a "fake passes, real fails" gap — fix the fake too, or the bug stays invisible to CI.

## 3. STEP 1 — Confirm the real channel BEFORE coding (do not guess)

Two ground-truth sources; use both:

1. **Generated app-server types** (already present): inspect
   `plugins/codex/.generated/app-server-types/` — start with `ResponseItem.ts`, `ContentItem.ts`, `MessagePhase.ts`, and the `item/completed` item union. Find which item type/field carries final schema'd output. Regenerate if stale: `npm run prebuild`.
2. **Live capture** against the installed codex-cli (0.142.x). Add a temporary raw-notification dump inside `captureTurn`'s notification handler (`codex.mjs:556`) — log every `message.method` + `item.type` + keys — then run ONE real structured review (`/codex:review` or a minimal `turn/start` with `outputSchema`). Identify exactly where the JSON arrives. Candidates, in likely order:
   - an `agentMessage` item whose JSON is in a **structured/content field, not `.text`** (e.g. `ContentItem`/`AgentMessageInputContent`-shaped content array);
   - a **new item type** at `item/completed`;
   - the **`turn` object** on `turn/completed` (which `completeTurn` already receives at `codex.mjs:545` but never mines).

Record the real shape as a checked-in fixture (a captured notification sequence). This is the RED-test input.

## 4. STEP 2 — RED test

- Update/extend `tests/fake-codex-fixture.mjs` so the structured-review path emits output the **real** way found in Step 1 (NOT as `agentMessage.text`). Keep the old agentMessage path covered too (don't regress normal task messages/subagent capture).
- Add a test (in `tests/runtime.test.mjs` or a new `tests/structured-output.test.mjs`) asserting that a structured review yields a **non-empty `finalMessage` that `parseStructuredOutput` parses into `{verdict, summary, findings…}`**. It MUST fail against current `recordItem`/`completeTurn`.

## 5. STEP 3 — GREEN (the fix)

Extend capture to read the real channel into the final message. Minimal, targeted:
- If JSON rides in a structured **content field** of `agentMessage`: in `recordItem` (`codex.mjs:414`), when `item.text` is empty, derive text from the structured content (join text parts / stringify the structured payload) before setting `lastAgentMessage`.
- If it rides in a **new item type**: add a branch in `recordItem` capturing it into `lastAgentMessage` (or a new `finalStructured` field surfaced via `runTask` → `finalMessage`).
- If it rides on the **turn object**: in `completeTurn` (`codex.mjs:347`), extract the final output from `turn` into `lastAgentMessage` when no agentMessage text was seen.
Prefer the smallest change that matches Step 1's ground truth. Keep `agentMessage.text` as the primary path; the new channel is a fallback so normal (non-schema) turns are unaffected.

## 6. STEP 4 — Regression + live verify

- `npm test` green (existing 8 suites + the new test). Confirm normal task messages, subagent message capture, and reasoning summaries still work.
- `npm run lint` clean.
- **Live proof (required):** run a real `/codex:review` against a small diff; confirm parsed JSON, a real verdict, non-empty findings, and `parseError === null`. A passing fake alone does NOT close this bug.
- Version: bump per `npm run bump-version` conventions; note the fix in changelog/PR.

## 7. Scope guards

- **In scope:** `recordItem` / `completeTurn` capture, `runTask` return, the fake fixture, one new test.
- **Out of scope:** the broker/transport retry path (`withAppServer`), the codegraph MCP hang, and any redesign of the review prompt/schema. Don't touch them.
- Version-guard: keep backward compatibility with any CLI that still emits the old agentMessage shape (handle both; don't hard-swap).
- Don't print captured secrets/full prompts in test failure output.

## 8. Definition of done

- [ ] Real structured-output channel identified + documented (Step 1) with a checked-in captured fixture.
- [ ] Fake fixture emits the real shape; new RED test reproduces the empty-output bug.
- [ ] `recordItem`/`completeTurn` capture the real channel; test GREEN.
- [ ] Full `npm test` + `npm run lint` green; no regression to agentMessage/subagent/reasoning capture.
- [ ] Live `/codex:review` returns parsed JSON + real verdict (evidence pasted in PR).
- [ ] Both old and new CLI emission shapes handled.
