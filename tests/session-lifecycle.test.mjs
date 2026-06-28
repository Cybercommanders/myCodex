import test from "node:test";
import assert from "node:assert/strict";

import { handleSessionEnd } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

test("SessionEnd reaps jobs even when broker shutdown throws", async () => {
  let cleanupCalled = false;
  let teardownCalled = false;
  let clearCalled = false;

  await handleSessionEnd(
    { cwd: "/nonexistent-cxc", session_id: "s1" },
    {
      loadBrokerSession: () => ({ endpoint: "unix:/tmp/cxc-test.sock", pid: 999 }),
      sendBrokerShutdown: async () => {
        throw new Error("broker unreachable");
      },
      cleanupSessionJobs: () => {
        cleanupCalled = true;
      },
      teardownBrokerSession: () => {
        teardownCalled = true;
      },
      clearBrokerSession: () => {
        clearCalled = true;
      }
    }
  );

  assert.equal(cleanupCalled, true, "job cleanup must run despite broker shutdown failure");
  assert.equal(teardownCalled, true, "broker teardown must still run");
  assert.equal(clearCalled, true, "broker session must still be cleared");
});
