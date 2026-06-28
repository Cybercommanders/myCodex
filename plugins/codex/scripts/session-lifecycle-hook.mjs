#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { resolveStateFile, updateState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // R2: load → terminate → filter → save run as ONE locked critical section so a
  // background job completing concurrently is not clobbered. Failures are swallowed
  // so a busy/held lock never blocks session shutdown.
  try {
    updateState(workspaceRoot, (state) => {
      const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
      for (const job of removedJobs) {
        const stillRunning = job.status === "queued" || job.status === "running";
        if (!stillRunning) {
          continue;
        }
        try {
          terminateProcessTree(job.pid ?? Number.NaN);
        } catch {
          // Ignore teardown failures during session shutdown.
        }
      }
      state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
    });
  } catch {
    // Never block shutdown on a contended or lost state lock.
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

export async function handleSessionEnd(input, deps = {}) {
  // Deps are injectable for testing; default to the real implementations.
  const loadBroker = deps.loadBrokerSession ?? loadBrokerSession;
  const shutdownBroker = deps.sendBrokerShutdown ?? sendBrokerShutdown;
  const cleanupJobs = deps.cleanupSessionJobs ?? cleanupSessionJobs;
  const teardownBroker = deps.teardownBrokerSession ?? teardownBrokerSession;
  const clearBroker = deps.clearBrokerSession ?? clearBrokerSession;

  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBroker(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  // A broker that is already dead/unreachable must NOT skip job reaping. Reap
  // first in `finally` so a failed shutdown can never leave orphan codex procs.
  try {
    if (brokerEndpoint) {
      await shutdownBroker(brokerEndpoint);
    }
  } catch (error) {
    process.stderr.write(`codex: broker shutdown failed during SessionEnd: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    cleanupJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
    teardownBroker({
      endpoint: brokerEndpoint,
      pidFile,
      logFile,
      sessionDir,
      pid,
      killProcess: terminateProcessTree
    });
    clearBroker(cwd);
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
