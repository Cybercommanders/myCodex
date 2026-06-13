import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_DIR_MODE = 0o700;

// --- Cross-process lock tunables (FR1/FR2/FR9) ------------------------------
export const LOCK_DIR_NAME = ".state.lock";
const LOCK_TTL_MS = 30_000; // a dead owner older than this is stale
const LOCK_WAIT_MS = 10_000; // max wait to acquire before giving up
const LOCK_RETRY_MS = 25; // poll interval while waiting
const SAB_AVAILABLE =
  typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function";

function nowIso() {
  return new Date().toISOString();
}

function randSuffix() {
  return randomBytes(6).toString("hex");
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  // RC5 hardening is mode-based (0o700 dir + O_EXCL temps), NOT path relocation. An
  // earlier attempt namespaced the shared os.tmpdir() fallback per-uid, but any
  // relocation strands state written by a prior version (NFR4) and cannot be made
  // strand-free without a risky live-state migration. The path is therefore kept
  // identical to prior versions; ensureStateDir/withStateLock create it 0o700 and
  // temps use O_EXCL, so another user cannot pre-create lock/temp files (CWE-377).
  // CLAUDE_PLUGIN_DATA (the normal path) is already per-user. Limitation: two
  // DISTINCT users sharing the identical workspace path via the os.tmpdir() fallback
  // is unsupported (the 0o700 owner wins; the other gets EACCES, not a silent wedge).
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function stateRootDir() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
}

// Ensure the SHARED root exists without locking other users out. Applying 0o700 to
// a recursively-created tree would set it on the shared os.tmpdir() root too, so the
// first user to run would own it and every other user would get EACCES for ANY
// workspace (broad first-user-wins). Instead the shared tmp root is made sticky +
// world-usable (like /tmp): every uid can create its own 0o700 per-workspace leaf,
// and the sticky bit stops cross-user deletion. CLAUDE_PLUGIN_DATA is already
// per-user, so it needs no special mode.
function ensureStateRoot() {
  const root = stateRootDir();
  fs.mkdirSync(root, { recursive: true });
  if (process.env[PLUGIN_DATA_ENV] || process.platform === "win32") {
    return;
  }
  // CWE-59: chmod follows symlinks, so validate the root is a real dir BEFORE chmod —
  // otherwise a squatted symlinked root would have its target moded to 0o1777.
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw Object.assign(
      new Error(`refusing to use a symlinked state root (possible squat): ${root}. Set CLAUDE_PLUGIN_DATA.`),
      { code: "ESTATEOWNER" }
    );
  }
  try {
    fs.chmodSync(root, 0o1777);
  } catch {
    // Not the owner — another user already created the shared root; leave it.
  }
}

// Safe to use a state dir only if we own it. Unknown current uid (non-POSIX) or
// unknown stat uid ⇒ cannot check ⇒ treated as safe. Pure for unit testing.
export function isDirOwnershipSafe(statUid, currentUid) {
  if (typeof currentUid !== "number" || typeof statUid !== "number") {
    return true;
  }
  return statUid === currentUid;
}

// Create a per-workspace dir locked to 0o700 (CWE-377: contents — state, locks,
// temps — are owner-only) while keeping the shared root multi-user. A squatted leaf
// (a symlink, or a dir a local co-user pre-created and owns) MUST NOT be silently
// reused — we fail loudly so it is a clean error, never silent misuse.
function ensureWorkspaceDir(dir) {
  ensureStateRoot();
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    return;
  }
  // Validate BEFORE any chmod (CWE-59): chmod follows symlinks, so a squatted symlink
  // leaf would otherwise have its TARGET moded before we could reject it. lstat does
  // not follow; reject a symlink or a dir we don't own, then chmod the real owned dir.
  const info = fs.lstatSync(dir);
  const myUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (info.isSymbolicLink() || !isDirOwnershipSafe(info.uid, myUid)) {
    throw Object.assign(
      new Error(
        `refusing to use a state dir not owned by this user (possible squat): ${dir}. ` +
          `Set CLAUDE_PLUGIN_DATA to a private path.`
      ),
      { code: "ESTATEOWNER" }
    );
  }
  try {
    fs.chmodSync(dir, STATE_DIR_MODE); // safe: confirmed a real dir we own
  } catch {
    // best-effort; we own it
  }
}

export function ensureStateDir(cwd) {
  ensureWorkspaceDir(resolveStateDir(cwd));
  ensureWorkspaceDir(resolveJobsDir(cwd));
}

// --- Atomic, crash-safe writes (FR3, R3, R9, RC4/B8) ------------------------

function fsyncDir(dir) {
  let dfd;
  try {
    dfd = fs.openSync(dir, "r");
    fs.fsyncSync(dfd);
  } catch {
    // Some platforms (notably Windows) cannot fsync a directory — best-effort.
  } finally {
    if (dfd !== undefined) {
      try {
        fs.closeSync(dfd);
      } catch {
        // ignore close failure
      }
    }
  }
}

// POSIX rename is an atomic replace. Windows cannot replace an existing target,
// so make the replace CRASH-RECOVERABLE: snapshot the current good file to
// `<target>.bak` BEFORE unlinking, so a crash in the unlink→rename window leaves a
// recoverable `.bak` (loadState recovers from it). `crashBeforeRename` is a
// test-only seam that simulates the process dying inside that window.
export function renameOver(tmp, target, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    fs.renameSync(tmp, target); // atomic replace
    return;
  }
  const bak = `${target}.bak`;
  if (fs.existsSync(target)) {
    try {
      fs.copyFileSync(target, bak);
    } catch {
      // best-effort snapshot
    }
    fs.unlinkSync(target);
  }
  if (options.crashBeforeRename) {
    return; // simulate a crash in the recoverable window
  }
  fs.renameSync(tmp, target);
  try {
    fs.unlinkSync(bak);
  } catch {
    // ignore — leftover .bak is harmless
  }
}

export function atomicWriteFileSync(target, data) {
  const dir = path.dirname(target);
  ensureWorkspaceDir(dir);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${randSuffix()}`);
  const fd = fs.openSync(tmp, "wx"); // O_EXCL — no shared temp (R9), no symlink follow
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameOver(tmp, target);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore residue cleanup failure
      }
    }
  }
  fsyncDir(dir);
}

// --- Cross-process lock (FR1, FR2, FR9, FR10) -------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // EPERM ⇒ exists, owned by another user
  }
}

function safeReadOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  if (SAB_AVAILABLE) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  }
  spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`]);
}

// RC1/B1: a reclaimer NEVER rmSyncs the live lock path. It atomically renames the
// stale dir to a private grave (only one renamer wins) then verifies the grabbed
// token matches the stale token it inspected; on mismatch a fresh holder acquired
// in the window, so it renames the dir back and leaves it alone. Ownership is
// granted ONLY by a subsequent mkdirSync succeeding.
export function reclaimIfStale(stateDir, lockDir) {
  const owner = safeReadOwner(lockDir);
  let stale;
  if (owner == null) {
    // No owner descriptor yet: either a writer mid-acquire (it has mkdir'd the dir
    // but not yet written owner.json — do NOT steal it) or a process that crashed
    // before writing. Use the lock dir's own age; only reclaim past the TTL grace.
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(lockDir).mtimeMs;
    } catch {
      return; // already gone
    }
    stale = Date.now() - mtimeMs > LOCK_TTL_MS;
  } else {
    const ownerLocal = owner.host === os.hostname();
    const ageMs = Date.now() - Date.parse(owner.startedAt ?? 0);
    // R7: cross-host or recycled-PID owners are stale even with a live PID number.
    const ownerAlive = Boolean(ownerLocal) && Boolean(owner.pid) && isAlive(owner.pid) && ageMs <= LOCK_TTL_MS;
    stale = !ownerAlive;
  }
  if (!stale) {
    return;
  }

  const grave = path.join(stateDir, `.state.lock.dead-${process.pid}-${randSuffix()}`);
  try {
    fs.renameSync(lockDir, grave); // atomic claim of the REMOVAL
  } catch {
    return; // someone else won the rename; re-loop and contend on mkdir
  }

  const grabbed = safeReadOwner(grave);
  if (grabbed?.token && owner?.token && grabbed.token !== owner.token) {
    try {
      fs.renameSync(grave, lockDir); // we grabbed a FRESH lock — put it back
    } catch {
      // fresh holder already released; nothing to restore
    }
    return;
  }
  try {
    fs.rmSync(grave, { recursive: true, force: true }); // safe: we exclusively own `grave`
  } catch {
    // ignore
  }
}

export function acquireStateLock(stateDir) {
  const lockDir = path.join(stateDir, LOCK_DIR_NAME);
  const token = `${process.pid}-${os.hostname()}-${randSuffix()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir); // atomic — the ONLY proof of ownership (RC1)
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: nowIso() }),
        "utf8"
      );
      return { lockDir, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      reclaimIfStale(stateDir, lockDir); // may remove a dead lock — never grants ownership
      if (Date.now() > deadline) {
        throw new Error("state lock busy");
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

export function releaseStateLock(lockDir, token) {
  try {
    const owner = safeReadOwner(lockDir);
    if (!token || owner == null || owner.token === token) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // ignore release failure
  }
}

// RC1 fencing: a holder re-validates its token immediately before committing a
// write; if it changed, the lock was reclaimed and the holder must re-acquire.
export function assertStillOwner(lockDir, token) {
  if (safeReadOwner(lockDir)?.token !== token) {
    throw Object.assign(new Error("state lock lost"), { code: "ELOCKLOST" });
  }
}

export function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  ensureWorkspaceDir(stateDir);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { lockDir, token } = acquireStateLock(stateDir);
    try {
      return fn({ lockDir, token });
    } catch (error) {
      if (error?.code === "ELOCKLOST") {
        lastError = error;
        continue; // re-acquire and retry
      }
      throw error;
    } finally {
      releaseStateLock(lockDir, token);
    }
  }
  throw lastError ?? new Error("state lock repeatedly lost");
}

// --- Load / recover (FR4, R5, R10, RC2, RC4) --------------------------------

function normalizeState(parsed) {
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

// RC2/B6: the per-job files are a redundant source of truth (atomic via FR3), so a
// corrupt state.json does not lose live PIDs — /codex:status can still see them.
function reconstructFromJobFiles(cwd) {
  const dir = resolveJobsDir(cwd);
  const jobs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    } catch {
      // skip an unreadable job file
    }
  }
  return { ...defaultState(), jobs };
}

export function loadState(cwd, { locked = false } = {}) {
  const stateFile = resolveStateFile(cwd);

  if (!fs.existsSync(stateFile)) {
    // RC4/B8: recover from the Windows-replace snapshot if the target is missing.
    const bak = `${stateFile}.bak`;
    if (fs.existsSync(bak)) {
      try {
        return normalizeState(JSON.parse(fs.readFileSync(bak, "utf8")));
      } catch {
        // fall through to default
      }
    }
    return defaultState();
  }

  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return defaultState();
  }

  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    if (!locked) {
      // R5: unlocked readers (/codex:status, gate, listJobs, getConfig) never rename.
      return defaultState();
    }
    const backup = `${stateFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stateFile, backup);
    } catch {
      // leave the corrupt file in place if we cannot move it
    }
    const rebuilt = reconstructFromJobFiles(cwd);
    process.stderr.write(
      `[codex] state.json was unreadable; quarantined to ${backup}. ` +
        `Rebuilt ${rebuilt.jobs.length} job(s) from jobs/*.json — run /codex:status to verify.\n`
    );
    return rebuilt;
  }
}

// --- Mutation (all serialized through withStateLock) ------------------------

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, ({ lockDir, token }) => {
    assertStillOwner(lockDir, token);
    return saveStateLocked(cwd, state);
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, ({ lockDir, token }) => {
    const state = loadState(cwd, { locked: true }); // re-read INSIDE the lock (F1)
    mutate(state);
    assertStillOwner(lockDir, token); // RC1 fencing before commit
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
