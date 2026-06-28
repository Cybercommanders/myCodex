import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

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
