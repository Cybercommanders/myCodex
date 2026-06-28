import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { runCommand, terminateProcessTree, isOwnedCodexProcess } from "../plugins/codex/scripts/lib/process.mjs";

const SELF = 1000;

test("isOwnedCodexProcess: a tracked pid owned by self matches", () => {
  assert.equal(isOwnedCodexProcess({ pid: 42, trackedPids: [42], uid: SELF, self: SELF, argv0: "anything" }), true);
});

test("isOwnedCodexProcess: a tracked pid owned by another user is never signalled", () => {
  assert.equal(isOwnedCodexProcess({ pid: 42, trackedPids: [42], uid: 0, self: SELF, argv0: "codex" }), false);
});

test("isOwnedCodexProcess: any process owned by another user is excluded (spares root earlyoom)", () => {
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: 0, self: SELF, argv0: "/usr/bin/earlyoom", argv1: "--avoid codex" }), false);
});

test("isOwnedCodexProcess: argv0 basename codex / codex-companion matches", () => {
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "/home/x/.bun/bin/codex" }), true);
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "codex-companion" }), true);
});

test("isOwnedCodexProcess: node running codex-companion.mjs matches", () => {
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "node", argv1: "/plugins/codex/scripts/codex-companion.mjs" }), true);
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "node", argv1: "/some/other.mjs" }), false);
});

test("isOwnedCodexProcess: CODEX_COMPANION_SESSION_ID env marks ownership", () => {
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "node", env: { CODEX_COMPANION_SESSION_ID: "s1" } }), true);
});

test("isOwnedCodexProcess: a bare argv substring 'codex' never matches", () => {
  assert.equal(isOwnedCodexProcess({ pid: 9, trackedPids: [], uid: SELF, self: SELF, argv0: "grep", argv1: "-r codex" }), false);
});

test("runCommand kills and reports ETIMEDOUT when a child exceeds timeoutMs", () => {
  const start = Date.now();
  const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    timeoutMs: 200
  });
  const elapsed = Date.now() - start;

  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.ok(elapsed < 5000, `expected fast timeout, took ${elapsed}ms`);
});

test("terminateProcessTree escalates to SIGKILL when the process survives SIGTERM", () => {
  const calls = [];
  terminateProcessTree(4321, {
    platform: "linux",
    graceMs: 0,
    scheduleImpl: (fn) => fn(),
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      // Process stays alive: the liveness probe and signals all succeed.
    }
  });

  assert.deepEqual(calls[0], { pid: -4321, signal: "SIGTERM" });
  assert.ok(
    calls.some((c) => c.pid === -4321 && c.signal === "SIGKILL"),
    "expected SIGKILL escalation to the process group"
  );
});

test("terminateProcessTree does not SIGKILL a process that already exited", () => {
  const calls = [];
  terminateProcessTree(4321, {
    platform: "linux",
    graceMs: 0,
    scheduleImpl: (fn) => fn(),
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      if (signal === 0) {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error; // liveness probe: process is gone
      }
    }
  });

  assert.ok(!calls.some((c) => c.signal === "SIGKILL"), "must not SIGKILL a dead process");
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
