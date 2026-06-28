import test from "node:test";
import assert from "node:assert/strict";

import { parseInitArgs, decideInitPlan, renderProcessesSection } from "../plugins/codex/scripts/codex-init-preflight.mjs";

// --- parseInitArgs: tri-state gate + flags --------------------------------

test("bare init preserves the gate (no enable/disable flag)", () => {
  const o = parseInitArgs([]);
  assert.equal(o.gateIntent, "preserve");
  assert.equal(o.force, false);
  assert.equal(o.reap, false);
});

test("--enable-review-gate / --disable-review-gate set explicit intent", () => {
  assert.equal(parseInitArgs(["--enable-review-gate"]).gateIntent, "enable");
  assert.equal(parseInitArgs(["--disable-review-gate"]).gateIntent, "disable");
});

test("--force and --reap parse", () => {
  const o = parseInitArgs(["--force", "--reap"]);
  assert.equal(o.force, true);
  assert.equal(o.reap, true);
});

test("conflicting gate flags throw", () => {
  assert.throws(() => parseInitArgs(["--enable-review-gate", "--disable-review-gate"]), /either/i);
});

// --- decideInitPlan: idempotency core (pure) ------------------------------

test("preserve on an already-initialized gate-disabled repo does NOT re-enable", () => {
  const plan = decideInitPlan({ ready: true, firstInit: false, currentGate: false, gateIntent: "preserve", force: false });
  assert.equal(plan.gateFlag, null, "must not touch the gate");
  assert.equal(plan.skip, true, "already healthy + no change → skip heavy re-init");
});

test("first-time init defaults the gate ON under preserve (skill parity)", () => {
  const plan = decideInitPlan({ ready: false, firstInit: true, currentGate: false, gateIntent: "preserve", force: false });
  assert.equal(plan.gateFlag, "--enable-review-gate");
  assert.equal(plan.skip, false);
});

test("explicit --disable-review-gate overrides even when currently enabled", () => {
  const plan = decideInitPlan({ ready: true, firstInit: false, currentGate: true, gateIntent: "disable", force: false });
  assert.equal(plan.gateFlag, "--disable-review-gate");
  assert.equal(plan.skip, false, "a gate change is real work, never skipped");
});

test("explicit --enable when already enabled is a no-op (skip)", () => {
  const plan = decideInitPlan({ ready: true, firstInit: false, currentGate: true, gateIntent: "enable", force: false });
  assert.equal(plan.gateFlag, null);
  assert.equal(plan.skip, true);
});

test("--force re-runs setup even when already healthy", () => {
  const plan = decideInitPlan({ ready: true, firstInit: false, currentGate: true, gateIntent: "preserve", force: true });
  assert.equal(plan.skip, false);
});

test("not-ready repo never skips", () => {
  const plan = decideInitPlan({ ready: false, firstInit: false, currentGate: true, gateIntent: "preserve", force: false });
  assert.equal(plan.skip, false);
});

// --- renderProcessesSection: read-only monitoring -------------------------

test("renderProcessesSection reports jobs, broker liveness, orphans, stale locks", () => {
  const out = renderProcessesSection({
    jobs: [{ id: "task-1", status: "running", pid: 111 }],
    broker: { pid: 222, alive: true, idleMs: 1234, endpoint: "unix:/tmp/cxc-x/broker.sock" },
    orphans: [{ pid: 333, command: "node codex-companion.mjs review-worker" }],
    staleLocks: ["/state/.state.lock"]
  });
  assert.match(out, /^\[processes\]/m);
  assert.match(out, /task-1.*running.*111/);
  assert.match(out, /broker.*222.*alive/i);
  assert.match(out, /orphan.*333/i);
  assert.match(out, /stale lock.*\.state\.lock/i);
});

test("renderProcessesSection states 'none' cleanly when idle", () => {
  const out = renderProcessesSection({ jobs: [], broker: null, orphans: [], staleLocks: [] });
  assert.match(out, /^\[processes\]/m);
  assert.match(out, /no running jobs/i);
  assert.match(out, /no broker/i);
  assert.match(out, /no orphan/i);
});
