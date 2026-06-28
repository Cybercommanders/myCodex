#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getConfig, listJobs, resolveStateDir, resolveStateFile, inspectLockDir, reclaimIfStale, LOCK_DIR_NAME } from "./lib/state.mjs";
import { loadBrokerSession } from "./lib/broker-lifecycle.mjs";
import { isOwnedCodexProcess, terminateProcessTree } from "./lib/process.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(SCRIPT_DIR, "codex-companion.mjs");
const ROOT = path.resolve(SCRIPT_DIR, "..");

export function parseInitArgs(argv) {
  const options = {
    cwd: process.cwd(),
    json: false,
    gateIntent: "preserve", // "enable" | "disable" | "preserve"
    force: false,
    reap: false,
    foregroundReview: false,
    backgroundReview: false,
    mywsl: true,
    help: false
  };

  let enable = false;
  let disable = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--cwd") options.cwd = argv[++index] ?? options.cwd;
    else if (arg === "--enable-review-gate") enable = true;
    else if (arg === "--disable-review-gate") disable = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--reap") options.reap = true;
    else if (arg === "--foreground-review") options.foregroundReview = true;
    else if (arg === "--background-review") options.backgroundReview = true;
    else if (arg === "--no-mywsl") options.mywsl = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (enable && disable) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  options.gateIntent = enable ? "enable" : disable ? "disable" : "preserve";
  return options;
}

// Pure idempotency core: given current state + requested intent, decide whether
// the gate must change and whether the heavy re-init can be skipped.
export function decideInitPlan({ ready, firstInit, currentGate, gateIntent, force }) {
  let desiredGate;
  if (gateIntent === "enable") desiredGate = true;
  else if (gateIntent === "disable") desiredGate = false;
  else desiredGate = firstInit ? true : currentGate; // preserve: default-on only first time

  const gateFlag =
    desiredGate === currentGate ? null : desiredGate ? "--enable-review-gate" : "--disable-review-gate";

  // Skip the mutating re-init only when already healthy, no gate change is
  // needed, and the user did not force it.
  const skip = !force && ready && gateFlag === null;
  return { desiredGate, gateFlag, skip };
}

const HELP_TEXT = `codex init preflight — initialize Codex for a repo and run health checks.

Usage: codex-init-preflight.mjs [options]

  --enable-review-gate    Enable the stop-time review gate
  --disable-review-gate   Disable the stop-time review gate
  (no gate flag)          Preserve the current gate (default-on only on first init)
  --force                 Re-run setup even when already healthy
  --reap                  Terminate orphaned Codex/broker processes and clear stale locks
  --foreground-review     Run a blocking review as part of init
  --background-review     Queue a background adversarial review
  --no-mywsl              Skip the /myWSL health check
  --json                  Emit the full report as JSON
  --cwd <path>            Target repository (defaults to CWD)
  -h, --help              Show this help
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal ?? null,
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}

function readJsonRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (!result.ok || !result.stdout) {
    return { ...result, json: null };
  }

  try {
    return { ...result, json: JSON.parse(result.stdout) };
  } catch (error) {
    return { ...result, json: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeSetup(setup) {
  const report = setup.json;
  return {
    ok: Boolean(setup.ok && report?.ready),
    ready: Boolean(report?.ready),
    auth: report?.auth ?? null,
    codex: report?.codex ?? null,
    reviewGateEnabled: Boolean(report?.reviewGateEnabled),
    sessionRuntime: report?.sessionRuntime ?? null,
    actionsTaken: report?.actionsTaken ?? [],
    nextSteps: report?.nextSteps ?? [],
    error: setup.error ?? setup.stderr ?? setup.parseError ?? null
  };
}

function getGitStatus(cwd) {
  const root = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const status = run("git", ["status", "--short", "--untracked-files=all"], { cwd });
  const nested = run("/usr/bin/find", [".", "-mindepth", "2", "(", "-name", ".git", "-type", "d", "-o", "-name", ".git", "-type", "f", ")", "-print"], {
    cwd,
    timeoutMs: 10_000
  });

  return {
    isRepo: root.ok,
    root: root.stdout || null,
    dirty: Boolean(status.stdout),
    status: status.stdout,
    nestedGitMarkers: nested.ok && nested.stdout ? nested.stdout.split(/\r?\n/).filter(Boolean) : []
  };
}

function getMyWsl() {
  const candidates = [
    path.join(os.homedir(), "PAI/.claude/skills/_MYWSL/Tools/MyWSL.sh"),
    path.join(os.homedir(), ".claude/skills/_MYWSL/Tools/MyWSL.sh")
  ];
  const tool = candidates.find((candidate) => fs.existsSync(candidate));
  if (!tool) {
    return { ok: false, skipped: true, reason: "MyWSL tool not found" };
  }

  const result = run(tool, ["check"], { timeoutMs: 90_000 });
  const plain = String(result.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    signal: result.signal,
    error: result.error,
    verdict: /\bVERDICT\s+([A-Z]+)/.exec(plain)?.[1] ?? null,
    output: result.stdout,
    stderr: result.stderr
  };
}

function checkBundledFiles() {
  const files = [
    "commands/init.md",
    "commands/loop.md",
    "commands/setup.md",
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md",
    "scripts/codex-companion.mjs",
    "scripts/codex-init-preflight.mjs",
    "scripts/codex-loop.mjs",
    "hooks/hooks.json"
  ];

  return files.map((file) => {
    const fullPath = path.join(ROOT, file);
    return { file, exists: fs.existsSync(fullPath) };
  });
}

function pidAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but we can't signal it — still "alive".
    return error?.code === "EPERM";
  }
}

// Scan running processes once and classify Codex-owned ones (read-only). An
// "orphan" is an owned Codex process not tied to a tracked job and not the
// broker we know about.
function scanOwnedCodexProcesses(trackedPids, knownBrokerPid) {
  const ps = run("ps", ["-eo", "pid=,ppid=,euid=,command="], { timeoutMs: 10_000 });
  if (!ps.ok || !ps.stdout) return [];
  const self = typeof process.getuid === "function" ? process.getuid() : null;
  const owned = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const uid = Number(m[3]);
    const command = m[4];
    if (pid === process.pid) continue;
    const tokens = command.split(/\s+/);
    if (!isOwnedCodexProcess({ argv0: tokens[0], argv1: tokens[1], uid, self, trackedPids, pid })) continue;
    owned.push({ pid, ppid, command, tracked: trackedPids.includes(pid), isBroker: pid === knownBrokerPid });
  }
  return owned;
}

function collectProcesses(cwd) {
  let jobs = [];
  try {
    jobs = listJobs(cwd).filter((job) => job.status === "running" || job.status === "queued");
  } catch {
    jobs = [];
  }

  let broker = null;
  try {
    const session = loadBrokerSession(cwd);
    if (session?.pid) {
      broker = {
        pid: session.pid,
        alive: pidAlive(session.pid),
        endpoint: session.endpoint ?? null
      };
    }
  } catch {
    broker = null;
  }

  const trackedPids = jobs.map((job) => job.pid).filter((pid) => Number.isFinite(pid));
  const owned = scanOwnedCodexProcesses(trackedPids, broker?.pid ?? null);
  const orphans = owned.filter((p) => !p.tracked && !p.isBroker && p.ppid === 1);

  // Stale-lock detection uses the CANONICAL predicate from state.mjs — never a
  // weaker local rule. A mid-acquire lock (dir present, owner.json not yet
  // written, recent) is NOT stale, so --reap can never steal a live lock.
  const staleLocks = [];
  try {
    const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
    const lock = inspectLockDir(lockDir);
    if (lock.present && lock.stale) {
      staleLocks.push(lockDir);
    }
  } catch {
    // best-effort
  }

  return { jobs, broker, orphans, staleLocks };
}

export function renderProcessesSection(data) {
  const lines = ["[processes]"];
  if (data.jobs.length === 0) {
    lines.push("- no running jobs");
  } else {
    for (const job of data.jobs) {
      lines.push(`- job ${job.id}: ${job.status} pid=${job.pid ?? "?"}`);
    }
  }
  if (!data.broker) {
    lines.push("- no broker session recorded");
  } else {
    lines.push(`- broker pid=${data.broker.pid}: ${data.broker.alive ? "alive" : "dead"}${data.broker.idleMs != null ? ` idle=${Math.round(data.broker.idleMs / 1000)}s` : ""}${data.broker.endpoint ? ` ${data.broker.endpoint}` : ""}`);
  }
  if (data.orphans.length === 0) {
    lines.push("- no orphan Codex processes");
  } else {
    for (const orphan of data.orphans) {
      lines.push(`- orphan Codex process pid=${orphan.pid} (ppid=${orphan.ppid}): ${orphan.command}`);
    }
  }
  for (const lock of data.staleLocks) {
    lines.push(`- stale lock: ${lock}`);
  }
  return lines.join("\n");
}

function render(report) {
  const lines = [];
  lines.push("[cleanup]");
  if (report.reaped && report.reaped.length > 0) {
    for (const action of report.reaped) lines.push(`- ${action}`);
  } else if (report.reaped) {
    lines.push("- --reap: nothing to clean up");
  } else {
    lines.push("- read-only; run /codex:init --reap to terminate orphans and clear stale locks");
  }
  lines.push("");
  lines.push("[memory]");
  lines.push("- see repo-local /myWSL and Codex memory procedures for deep incident history");
  lines.push("");
  lines.push("[init]");
  lines.push(`- repo: ${report.cwd}`);
  if (report.plan?.skipped) lines.push("- already initialized (skipped re-init; use --force to re-run)");
  if (report.plan?.gateFlag) lines.push(`- gate change applied: ${report.plan.gateFlag}`);
  lines.push(`- git: ${report.git.isRepo ? "repo" : "not-repo"}${report.git.dirty ? " dirty" : " clean"}`);
  lines.push(`- setup: ${report.setup.ok ? "completed" : `failed${report.setup.error ? `: ${report.setup.error}` : ""}`}`);
  lines.push(`- auth: ${report.setup.auth?.loggedIn ? "logged-in" : "not-verified"}`);
  lines.push(`- runtime: ${report.setup.sessionRuntime?.mode ?? "unknown"}`);
  lines.push(`- review-gate: ${report.setup.reviewGateEnabled ? "enabled" : "disabled"}`);
  if (report.foregroundReview) lines.push(`- foreground-review: ${report.foregroundReview.ok ? "completed" : `failed rc=${report.foregroundReview.status}`}`);
  if (report.backgroundReview) {
    lines.push(`- background-review: ${report.backgroundReview.ok ? "queued" : `failed rc=${report.backgroundReview.status}`}`);
  }
  if (report.mywsl) lines.push(`- myWSL: ${report.mywsl.verdict ?? (report.mywsl.skipped ? "skipped" : "unknown")}`);
  lines.push("");
  lines.push(renderProcessesSection(report.processes));
  lines.push("");
  lines.push("[warnings]");
  const warnings = report.warnings.length ? report.warnings : ["none"];
  for (const warning of warnings) lines.push(`- ${warning}`);
  return `${lines.join("\n")}\n`;
}

// --reap: terminate orphaned Codex/broker processes and clear stale locks.
// Only ever touches processes isOwnedCodexProcess vouched for (this user's own).
function reapOrphans(processes, warnings, dryRun) {
  const reaped = [];
  for (const orphan of processes.orphans) {
    if (dryRun) {
      reaped.push(`would terminate orphan pid=${orphan.pid}`);
      continue;
    }
    try {
      const outcome = terminateProcessTree(orphan.pid);
      reaped.push(`terminated orphan pid=${orphan.pid} (${outcome.method ?? "n/a"}, delivered=${outcome.delivered})`);
    } catch (error) {
      warnings.push(`failed to terminate orphan pid=${orphan.pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const lock of processes.staleLocks) {
    if (dryRun) {
      reaped.push(`would reclaim stale lock ${lock}`);
      continue;
    }
    try {
      // Use the canonical atomic reclaim, NOT a blind rmSync: it re-checks
      // staleness under the same race-safe protocol and never removes a lock a
      // fresh holder grabbed in the meantime.
      const stateDir = path.dirname(lock);
      reclaimIfStale(stateDir, lock);
      reaped.push(fs.existsSync(lock) ? `stale lock retained (fresh holder): ${lock}` : `reclaimed stale lock ${lock}`);
    } catch (error) {
      warnings.push(`failed to reclaim stale lock ${lock}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return reaped;
}

async function main() {
  const options = parseInitArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const cwd = path.resolve(options.cwd);
  const warnings = [];

  const git = getGitStatus(cwd);
  if (!git.isRepo) warnings.push("cwd is not inside a git repository");
  if (git.nestedGitMarkers.length > 0) warnings.push(`nested git markers found: ${git.nestedGitMarkers.join(", ")}`);

  const bundle = checkBundledFiles();
  for (const missing of bundle.filter((entry) => !entry.exists)) {
    warnings.push(`missing bundled file: ${missing.file}`);
  }

  // Idempotency: read current gate + first-init signal cheaply (no subprocess),
  // then decide whether the mutating setup must run at all.
  let currentGate = false;
  try {
    currentGate = Boolean(getConfig(cwd).stopReviewGate);
  } catch {
    currentGate = false;
  }
  const firstInit = !fs.existsSync(resolveStateFile(cwd));

  // A cheap, non-mutating setup --json reports readiness without touching the gate.
  const probe = summarizeSetup(readJsonRun(process.execPath, [COMPANION, "setup", "--json", "--cwd", cwd], { cwd, timeoutMs: 60_000 }));
  const plan = decideInitPlan({ ready: probe.ok, firstInit, currentGate, gateIntent: options.gateIntent, force: options.force });

  let setup = probe;
  if (plan.skip) {
    warnings.push("already initialized — setup ready and gate unchanged; pass --force to re-run");
  } else if (plan.gateFlag || !probe.ok || options.force) {
    const setupArgs = ["setup", "--json", "--cwd", cwd];
    if (plan.gateFlag) setupArgs.push(plan.gateFlag);
    setup = summarizeSetup(readJsonRun(process.execPath, [COMPANION, ...setupArgs], { cwd, timeoutMs: 60_000 }));
  }
  if (!setup.ok) warnings.push("setup did not report ready");
  for (const step of setup.nextSteps) warnings.push(step);

  let foregroundReview = null;
  if (options.foregroundReview) {
    foregroundReview = run(process.execPath, [COMPANION, "review", "--wait", "--scope", "working-tree", "--cwd", cwd], {
      cwd,
      timeoutMs: 15 * 60_000
    });
    if (!foregroundReview.ok) warnings.push("foreground review failed");
  }

  let backgroundReview = null;
  if (options.backgroundReview) {
    backgroundReview = run(process.execPath, [COMPANION, "adversarial-review", "--background", "--cwd", cwd], {
      cwd,
      timeoutMs: 60_000
    });
    if (!backgroundReview.ok) warnings.push("background adversarial review failed to queue");
  }

  const mywsl = options.mywsl ? getMyWsl() : null;
  if (mywsl && mywsl.status === 2) warnings.push("myWSL reported CRIT");
  if (mywsl && !mywsl.ok) warnings.push(`myWSL check failed${mywsl.status == null ? "" : ` rc=${mywsl.status}`}`);

  // #2 read-only monitoring; #3 optional reap (only with --reap).
  const processes = collectProcesses(cwd);
  if (processes.orphans.length > 0 && !options.reap) {
    warnings.push(`${processes.orphans.length} orphan Codex process(es) found — run /codex:init --reap to clean up`);
  }
  let reaped = null;
  if (options.reap) {
    reaped = reapOrphans(processes, warnings, process.env.CODEX_INIT_DRY_RUN === "1");
  }

  const report = {
    cwd,
    git,
    bundle,
    setup,
    plan: { skipped: plan.skip, gateFlag: plan.gateFlag, firstInit },
    foregroundReview,
    backgroundReview,
    mywsl,
    processes,
    reaped,
    warnings
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(render(report));
  }

  if (!setup.ok || mywsl?.status === 2 || foregroundReview?.ok === false || backgroundReview?.ok === false) {
    process.exitCode = 1;
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
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
