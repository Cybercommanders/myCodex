#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = path.join(SCRIPT_DIR, "codex-init-preflight.mjs");
const DEFAULT_DEV_ROOT = path.join(os.homedir(), "dev");

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    repos: [],
    discoverDev: false,
    devRoot: DEFAULT_DEV_ROOT,
    activeDays: 90,
    limit: 0,
    once: true,
    maxIterations: 1,
    intervalSec: 300,
    runTests: false,
    foregroundReview: false,
    backgroundReview: false,
    push: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") options.cwd = argv[++index] ?? options.cwd;
    else if (arg === "--repo") options.repos.push(argv[++index]);
    else if (arg === "--discover-dev") options.discoverDev = true;
    else if (arg === "--dev-root") options.devRoot = argv[++index] ?? options.devRoot;
    else if (arg === "--active-days") options.activeDays = Number(argv[++index] ?? options.activeDays);
    else if (arg === "--limit") options.limit = Number(argv[++index] ?? options.limit);
    else if (arg === "--once") {
      options.once = true;
      options.maxIterations = 1;
    } else if (arg === "--max-iterations") {
      options.once = false;
      options.maxIterations = Math.max(1, Number(argv[++index] ?? 1));
    } else if (arg === "--interval-sec") options.intervalSec = Math.max(1, Number(argv[++index] ?? options.intervalSec));
    else if (arg === "--run-tests") options.runTests = true;
    else if (arg === "--foreground-review") options.foregroundReview = true;
    else if (arg === "--background-review") options.backgroundReview = true;
    else if (arg === "--push") options.push = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 32 * 1024 * 1024
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

function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function myWslCheck() {
  const candidates = [
    path.join(os.homedir(), "PAI/.claude/skills/_MYWSL/Tools/MyWSL.sh"),
    path.join(os.homedir(), ".claude/skills/_MYWSL/Tools/MyWSL.sh")
  ];
  const tool = candidates.find((candidate) => fs.existsSync(candidate));
  if (!tool) return { ok: true, skipped: true, verdict: "SKIPPED", reason: "MyWSL tool not found" };
  const result = run(tool, ["check"], { timeoutMs: 90_000 });
  const plain = stripAnsi(result.stdout);
  const verdict = /\bVERDICT\s+([A-Z]+)/.exec(plain)?.[1] ?? null;
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    verdict,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function resolveGitRoot(cwd) {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  return result.ok && result.stdout ? path.resolve(result.stdout) : null;
}

function isActiveRepo(repo, activeDays) {
  const gitDir = path.join(repo, ".git");
  if (!fs.existsSync(gitDir)) return false;
  const cutoffMs = Date.now() - activeDays * 24 * 60 * 60 * 1000;
  const probes = [
    gitDir,
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "index"),
    path.join(gitDir, "logs", "HEAD")
  ];
  return probes.some((probe) => {
    try {
      return fs.statSync(probe).mtimeMs >= cutoffMs;
    } catch {
      return false;
    }
  });
}

function discoverRepos(devRoot, activeDays, limit) {
  if (!fs.existsSync(devRoot)) return [];
  const result = run("/usr/bin/find", [devRoot, "-maxdepth", "2", "-type", "d", "-name", ".git", "-print"], {
    cwd: devRoot,
    timeoutMs: 60_000
  });
  if (!result.ok || !result.stdout) return [];
  const repos = [...new Set(result.stdout.split(/\r?\n/).filter(Boolean).map((gitPath) => path.dirname(gitPath)))]
    .filter((repo) => isActiveRepo(repo, activeDays))
    .sort();
  return limit > 0 ? repos.slice(0, limit) : repos;
}

function detectPackageManager(repo) {
  if (fs.existsSync(path.join(repo, "bun.lockb")) || fs.existsSync(path.join(repo, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repo, "package.json"))) return "npm";
  return null;
}

function packageHasTest(repo) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.test);
  } catch {
    return false;
  }
}

function runTests(repo) {
  if (!packageHasTest(repo)) {
    return { skipped: true, reason: "no package.json test script" };
  }
  const manager = detectPackageManager(repo);
  if (manager === "bun") return run("bun", ["test"], { cwd: repo, timeoutMs: 20 * 60_000 });
  if (manager === "pnpm") return run("pnpm", ["test"], { cwd: repo, timeoutMs: 20 * 60_000 });
  if (manager === "yarn") return run("yarn", ["test"], { cwd: repo, timeoutMs: 20 * 60_000 });
  return run("npm", ["test"], { cwd: repo, timeoutMs: 20 * 60_000 });
}

function gitStatus(repo) {
  const status = run("git", ["status", "--short", "--branch"], { cwd: repo, timeoutMs: 20_000 });
  const ahead = /\[ahead\s+\d+/.test(status.stdout);
  const dirty = status.stdout.split(/\r?\n/).slice(1).some(Boolean);
  return { ...status, ahead, dirty };
}

function maybePush(repo, enabled) {
  if (!enabled) return { skipped: true, reason: "--push not set" };
  const status = gitStatus(repo);
  if (!status.ok) return { skipped: true, reason: "git status failed", status };
  if (status.dirty) return { skipped: true, reason: "working tree dirty", status };
  if (!status.ahead) return { skipped: true, reason: "branch not ahead", status };
  const remote = run("git", ["remote"], { cwd: repo, timeoutMs: 10_000 });
  if (!remote.ok || !remote.stdout) return { skipped: true, reason: "no git remote", status };
  return run("git", ["push"], { cwd: repo, timeoutMs: 20 * 60_000 });
}

function runPreflight(repo, options) {
  const args = [PREFLIGHT, "--cwd", repo, "--json", "--no-mywsl"];
  if (options.foregroundReview) args.push("--foreground-review");
  if (options.backgroundReview) args.push("--background-review");
  return run(process.execPath, args, { cwd: repo, timeoutMs: options.foregroundReview ? 20 * 60_000 : 90_000 });
}

function parseJsonRun(result) {
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function render(report) {
  const lines = [];
  lines.push(`[loop] repos=${report.repos.length} iterations=${report.iterations.length}`);
  if (report.stopReason) lines.push(`[stop] ${report.stopReason}`);
  for (const iteration of report.iterations) {
    lines.push("");
    lines.push(`[iteration ${iteration.index}] myWSL=${iteration.mywsl.verdict ?? "unknown"}`);
    for (const repo of iteration.repos) {
      const status = repo.ok ? "OK" : "WARN";
      const tests = repo.tests?.skipped ? "skipped" : repo.tests ? (repo.tests.ok ? "ok" : `failed rc=${repo.tests.status}`) : "off";
      const push = repo.push?.skipped ? `skipped:${repo.push.reason}` : repo.push ? (repo.push.ok ? "ok" : `failed rc=${repo.push.status}`) : "off";
      lines.push(`- ${status} ${repo.path} preflight=${repo.preflight.ok ? "ok" : `failed rc=${repo.preflight.status}`} tests=${tests} push=${push}`);
      for (const warning of repo.warnings) lines.push(`  warning: ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repos = [
    ...options.repos.map((repo) => path.resolve(repo)),
    ...(options.discoverDev ? discoverRepos(path.resolve(options.devRoot), options.activeDays, options.limit) : [])
  ];
  if (repos.length === 0) {
    const root = resolveGitRoot(path.resolve(options.cwd));
    repos.push(root ?? path.resolve(options.cwd));
  }

  const report = {
    options: {
      discoverDev: options.discoverDev,
      activeDays: options.activeDays,
      runTests: options.runTests,
      foregroundReview: options.foregroundReview,
      backgroundReview: options.backgroundReview,
      push: options.push
    },
    repos: [...new Set(repos)],
    iterations: [],
    stopReason: null
  };

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const mywsl = myWslCheck();
    const iterationReport = { index: iteration, mywsl, repos: [] };
    report.iterations.push(iterationReport);
    if (mywsl.status === 2 || mywsl.verdict === "CRIT") {
      report.stopReason = "myWSL reported CRIT before repo work";
      break;
    }

    for (const repo of report.repos) {
      const preflight = runPreflight(repo, options);
      const preflightJson = parseJsonRun(preflight);
      const warnings = preflightJson?.warnings ?? [];
      const tests = options.runTests && preflight.ok ? runTests(repo) : null;
      const push = tests?.ok === false ? { skipped: true, reason: "tests failed" } : maybePush(repo, options.push);
      const ok = preflight.ok && tests?.ok !== false && push?.ok !== false;
      iterationReport.repos.push({
        path: repo,
        ok,
        preflight,
        preflightJson,
        warnings,
        tests,
        push
      });
    }

    const failures = iterationReport.repos.filter((repo) => !repo.ok);
    if (failures.length === 0) {
      report.stopReason = "converged";
      break;
    }
    if (options.once || iteration === options.maxIterations) {
      report.stopReason = `${failures.length} repo(s) still warning or failing`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalSec * 1000));
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(render(report));

  if (report.stopReason !== "converged") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
