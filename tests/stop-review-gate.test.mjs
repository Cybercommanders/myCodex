import test from "node:test";
import assert from "node:assert/strict";

import { decideStop } from "../plugins/codex/scripts/stop-review-gate-hook.mjs";

test("a timed-out review allows the stop (never blocks the session)", () => {
  const decision = decideStop({ ok: false, timedOut: true, reason: "review timed out and was skipped" }, null);
  assert.notEqual(decision.block, true, "a stuck review must not hold the session hostage");
  assert.equal(decision.allow, true);
  assert.match(decision.note, /timed out/);
});

test("an app-server crash / infra failure allows the stop with a warning (no block)", () => {
  const decision = decideStop(
    { ok: false, reason: "The stop-time Codex review task failed: codex app-server exited unexpectedly (exit 1)." },
    null
  );
  assert.notEqual(decision.block, true, "a review that could not run must not block the session");
  assert.equal(decision.allow, true);
  assert.match(decision.note, /exited unexpectedly/);
});

test("a genuine BLOCK verdict blocks with the failure reason", () => {
  const decision = decideStop({ ok: false, blockFinding: true, reason: "found issues" }, null);
  assert.equal(decision.block, true);
  assert.match(decision.reason, /found issues/);
});

test("a passing review allows the stop and surfaces the running-task note", () => {
  const decision = decideStop({ ok: true }, "job 7 still running");
  assert.equal(decision.allow, true);
  assert.equal(decision.note, "job 7 still running");
});
