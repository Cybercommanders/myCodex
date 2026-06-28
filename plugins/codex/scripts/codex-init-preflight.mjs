#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(SCRIPT_DIR, "codex-companion.mjs");
const ROOT = path.resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    json: false,
    enableReviewGate: true,
    foregroundReview: false,
    backgroundReview: false,
    mywsl: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--cwd") options.cwd = argv[++index] ?? options.cwd;
    else if (arg === "--disable-review-gate") options.enableReviewGate = false;
    else if (arg === "--foreground-review") options.foregroundReview = true;
    else if (arg === "--background-review") options.backgroundReview = true;
    else if (arg === "--no-mywsl") options.mywsl = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

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

function render(report) {
  const lines = [];
  lines.push("[cleanup]");
  lines.push("- preflight is read-only; no cleanup performed by this script");
  lines.push("");
  lines.push("[memory]");
  lines.push("- see repo-local /myWSL and Codex memory procedures for deep incident history");
  lines.push("");
  lines.push("[init]");
  lines.push(`- repo: ${report.cwd}`);
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
  lines.push("[warnings]");
  const warnings = report.warnings.length ? report.warnings : ["none"];
  for (const warning of warnings) lines.push(`- ${warning}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(options.cwd);
  const warnings = [];

  const git = getGitStatus(cwd);
  if (!git.isRepo) warnings.push("cwd is not inside a git repository");
  if (git.nestedGitMarkers.length > 0) warnings.push(`nested git markers found: ${git.nestedGitMarkers.join(", ")}`);

  const bundle = checkBundledFiles();
  for (const missing of bundle.filter((entry) => !entry.exists)) {
    warnings.push(`missing bundled file: ${missing.file}`);
  }

  const setupArgs = ["setup", "--json", "--cwd", cwd];
  if (options.enableReviewGate) setupArgs.push("--enable-review-gate");
  const setup = summarizeSetup(readJsonRun(process.execPath, [COMPANION, ...setupArgs], { cwd, timeoutMs: 60_000 }));
  if (!setup.ok) warnings.push("setup did not report ready");
  if (!setup.reviewGateEnabled && options.enableReviewGate) warnings.push("review gate not enabled");
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

  const report = {
    cwd,
    git,
    bundle,
    setup,
    foregroundReview,
    backgroundReview,
    mywsl,
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
