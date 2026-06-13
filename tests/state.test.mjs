import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  resolveJobsDir,
  saveState,
  loadState,
  withStateLock,
  acquireStateLock,
  releaseStateLock,
  reclaimIfStale,
  assertStillOwner,
  atomicWriteFileSync,
  renameOver,
  LOCK_DIR_NAME
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../plugins/codex/scripts/lib/state.mjs")
).href;

function writeOwner(stateDir, owner) {
  const lockDir = path.join(stateDir, LOCK_DIR_NAME);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
  return lockDir;
}

// --- TD.1 / M1: N parallel mutators lose zero job records --------------------
test("TD.1 concurrent upsertJob from N processes loses no jobs (M1)", async () => {
  const workspace = makeTempDir();
  const N = 25;
  const childSrc = `import { upsertJob } from ${JSON.stringify(STATE_URL)};\n`
    + `upsertJob(process.env.WS, { id: process.env.JID, status: "queued", pid: Number(process.env.JOBPID) });`;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childSrc], {
          env: { ...process.env, WS: workspace, JID: `job-${i}`, JOBPID: String(1000 + i) },
          stdio: ["ignore", "ignore", "pipe"]
        });
        let err = "";
        child.stderr.on("data", (d) => { err += d; });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${i} exit ${code}: ${err}`))));
        child.on("error", reject);
      })
    )
  );

  const jobs = loadState(workspace).jobs;
  assert.equal(jobs.length, N, `expected ${N} jobs, got ${jobs.length}`);
  assert.deepEqual(
    jobs.map((j) => j.id).sort(),
    Array.from({ length: N }, (_, i) => `job-${i}`).sort()
  );
});

// --- TD.2 / TD.5 / M7 / R7: stale-lock reclaim ------------------------------
test("TD.2 reclaimIfStale removes a dead-owner lock but keeps a live local one (M7)", () => {
  const stateDir = resolveStateDir(makeTempDir());
  fs.mkdirSync(stateDir, { recursive: true });

  // dead owner, old timestamp -> reclaimed
  const deadLock = writeOwner(stateDir, { token: "t1", pid: 2 ** 30, host: os.hostname(), startedAt: "2000-01-01T00:00:00.000Z" });
  reclaimIfStale(stateDir, deadLock);
  assert.equal(fs.existsSync(deadLock), false, "dead-owner lock should be reclaimed");

  // live local owner (this process), fresh -> kept
  const liveLock = writeOwner(stateDir, { token: "t2", pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  reclaimIfStale(stateDir, liveLock);
  assert.equal(fs.existsSync(liveLock), true, "live local lock must NOT be removed");
});

test("TD.5 reclaimIfStale treats a cross-host owner as stale (R7)", () => {
  const stateDir = resolveStateDir(makeTempDir());
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = writeOwner(stateDir, { token: "t", pid: process.pid, host: "some-other-host", startedAt: new Date().toISOString() });
  reclaimIfStale(stateDir, lock);
  assert.equal(fs.existsSync(lock), false, "cross-host owner (even live PID) must be stale");
});

// --- TD.4 / RC1: holder fencing ---------------------------------------------
test("TD.4 assertStillOwner throws when the owner token changes (RC1 fencing)", () => {
  const stateDir = resolveStateDir(makeTempDir());
  fs.mkdirSync(stateDir, { recursive: true });
  const { lockDir, token } = acquireStateLock(stateDir);
  try {
    assert.doesNotThrow(() => assertStillOwner(lockDir, token));
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "stolen" }), "utf8");
    assert.throws(() => assertStillOwner(lockDir, token), (e) => e.code === "ELOCKLOST");
  } finally {
    releaseStateLock(lockDir);
  }
});

test("TD.4b withStateLock re-acquires after a one-shot fencing loss", () => {
  const workspace = makeTempDir();
  let tampered = false;
  const result = withStateLock(workspace, ({ lockDir, token }) => {
    if (!tampered) {
      tampered = true;
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "x" }), "utf8");
      assertStillOwner(lockDir, token); // throws ELOCKLOST first attempt
    }
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(tampered, true);
});

// --- TD.14 / M2 / RC2: corrupt recovery reconstructs jobs -------------------
test("TD.14 locked loadState quarantines corrupt state and rebuilds jobs from job files (M2/RC2)", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobsDir = resolveJobsDir(workspace);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(resolveJobFile(workspace, "job-a"), JSON.stringify({ id: "job-a", status: "running", pid: 4242 }), "utf8");
  fs.writeFileSync(resolveJobFile(workspace, "job-b"), JSON.stringify({ id: "job-b", status: "queued", pid: 4243 }), "utf8");
  fs.writeFileSync(stateFile, "{ this is not json", "utf8");

  const state = loadState(workspace, { locked: true });
  const ids = state.jobs.map((j) => j.id).sort();
  assert.deepEqual(ids, ["job-a", "job-b"], "jobs reconstructed from jobs/*.json");
  assert.equal(state.jobs.find((j) => j.id === "job-a").pid, 4242, "live PID survives corruption");
  const backups = fs.readdirSync(path.dirname(stateFile)).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length >= 1, true, "corrupt bytes preserved as *.corrupt-*");
});

// --- TD.15 / R5: unlocked reader never renames ------------------------------
test("TD.15 unlocked loadState returns default on corrupt without renaming (R5)", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{ broken", "utf8");

  const state = loadState(workspace); // locked:false default
  assert.deepEqual(state.jobs, []);
  assert.equal(fs.existsSync(stateFile), true, "unlocked reader must not move the file");
  const backups = fs.readdirSync(path.dirname(stateFile)).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length, 0, "unlocked reader must not quarantine");
});

// --- TD.12: atomic write correctness, no temp residue -----------------------
test("TD.12 atomicWriteFileSync writes exact bytes and leaves no temp residue", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  atomicWriteFileSync(target, '{"v":1}\n');
  atomicWriteFileSync(target, '{"v":2}\n');
  assert.equal(fs.readFileSync(target, "utf8"), '{"v":2}\n');
  const residue = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(residue, [], "no .tmp-* residue after atomic write");
});

// --- TD.13 / RC4: Windows renameOver keeps a recoverable .bak ---------------
test("TD.13 renameOver windows branch leaves a recoverable .bak path (RC4/B8)", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  fs.writeFileSync(target, '{"old":true}\n', "utf8");
  const tmp = path.join(dir, ".state.json.tmp-test");
  fs.writeFileSync(tmp, '{"new":true}\n', "utf8");

  // simulate the crash window: snapshot+unlink without the final rename
  renameOver(tmp, target, { platform: "win32", crashBeforeRename: true });
  assert.equal(fs.existsSync(target), false, "target gone during the window");
  const bak = `${target}.bak`;
  assert.equal(fs.existsSync(bak), true, ".bak snapshot exists for recovery");
  assert.equal(JSON.parse(fs.readFileSync(bak, "utf8")).old, true);

  // loadState recovers from .bak when the target is missing
  const ws2 = makeTempDir();
  const sf2 = resolveStateFile(ws2);
  fs.mkdirSync(path.dirname(sf2), { recursive: true });
  fs.writeFileSync(`${sf2}.bak`, JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "j1", status: "running" }] }), "utf8");
  const recovered = loadState(ws2);
  assert.equal(recovered.jobs.length, 1, "loadState recovers jobs from .bak when target missing");
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir is stable and never relocates a workspace's state dir (NFR4)", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const workspace = makeTempDir();
    const first = resolveStateDir(workspace);
    // The fallback path carries no per-uid (or other relocating) segment, so it can
    // never strand prior state: writing state must not move where resolve points.
    assert.equal(first, path.join(os.tmpdir(), "codex-companion", path.basename(first)));
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, "state.json"), '{"version":1,"config":{},"jobs":[]}\n', "utf8");
    assert.equal(resolveStateDir(workspace), first, "state dir is stable across resolves");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("shared tmp root is multi-user (sticky world-usable); per-workspace dir is 0o700 (RC5)", { skip: process.platform === "win32" }, () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const workspace = makeTempDir();
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [] });

    const root = path.join(os.tmpdir(), "codex-companion");
    const stateDir = resolveStateDir(workspace);
    assert.equal(
      fs.statSync(root).mode & 0o1777,
      0o1777,
      "shared root must be sticky + world-usable so any uid can create its own leaf"
    );
    assert.equal(
      fs.statSync(stateDir).mode & 0o777,
      0o700,
      "per-workspace dir must be owner-only (CWE-377)"
    );
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
