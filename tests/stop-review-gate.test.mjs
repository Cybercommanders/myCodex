import test from "node:test";
import assert from "node:assert/strict";

import { decideStop } from "../plugins/codex/scripts/stop-review-gate-hook.mjs";

test("a timed-out review allows the stop (never blocks the session)", () => {
  const decision = decideStop({ ok: false, timedOut: true, reason: "review timed out and was skipped" }, null);
  assert.notEqual(decision.block, true, "a stuck review must not hold the session hostage");
  assert.equal(decision.allow, true);
  assert.match(decision.note, /timed out/);
});

test("a failed review blocks with the failure reason", () => {
  const decision = decideStop({ ok: false, reason: "found issues" }, null);
  assert.equal(decision.block, true);
  assert.match(decision.reason, /found issues/);
});

test("a passing review allows the stop and surfaces the running-task note", () => {
  const decision = decideStop({ ok: true }, "job 7 still running");
  assert.equal(decision.allow, true);
  assert.equal(decision.note, "job 7 still running");
});
