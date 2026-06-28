import { spawnSync } from "node:child_process";
import process from "node:process";

// Upper bound so a wedged child (hung binary check, stuck git, taskkill) can
// never block the host indefinitely. Per-call overridable; 0 disables.
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

// Grace window before escalating a still-alive process from SIGTERM to SIGKILL.
const SIGKILL_GRACE_MS = 3_000;

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

export function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    killSignal: "SIGKILL"
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function basename(p) {
  return String(p ?? "").split(/[\\/]/).pop() ?? "";
}

// Pure predicate (no I/O): is `pid` a Codex process THIS user owns and may
// signal? See process-safety.contract.md. Conservative by construction: it
// never matches a process owned by another user (spares root earlyoom, whose
// --avoid protect-list contains "codex"), and a bare argv substring "codex" is
// never a match.
export function isOwnedCodexProcess({ argv0, argv1, uid, self, env, trackedPids, pid } = {}) {
  const selfUid = self ?? (typeof process.getuid === "function" ? process.getuid() : uid);

  // A tracked job pid is ours iff still owned by us.
  if (Array.isArray(trackedPids) && trackedPids.includes(pid)) {
    return uid === selfUid;
  }

  // Never signal another user's process — defence beside the name matcher.
  if (uid !== selfUid) {
    return false;
  }

  const base0 = basename(argv0);
  if (base0 === "codex" || base0 === "codex-companion") {
    return true;
  }
  if (base0 === "node" && String(argv1 ?? "").endsWith("codex-companion.mjs")) {
    return true;
  }
  if (env && env.CODEX_COMPANION_SESSION_ID) {
    return true;
  }
  return false;
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const graceMs = options.graceMs ?? SIGKILL_GRACE_MS;
  const schedule = options.scheduleImpl ?? defaultSchedule;

  const escalate = () => {
    // Only escalate if the process is still alive (signal 0 probes liveness).
    try {
      killImpl(pid, 0);
    } catch {
      return; // ESRCH (gone) or EPERM (cannot signal) — nothing to escalate.
    }
    try {
      killImpl(-pid, "SIGKILL");
    } catch (error) {
      if (error?.code === "ESRCH") {
        try {
          killImpl(pid, "SIGKILL");
        } catch {
          // Best-effort; swallow ESRCH/EPERM per the process-safety contract.
        }
      }
      // Other errors (EPERM): swallow — never throw from the unref'd escalation.
    }
  };

  const armEscalation = () => {
    if (graceMs > 0 || options.scheduleImpl) {
      schedule(escalate, graceMs);
    }
  };

  try {
    killImpl(-pid, "SIGTERM");
    armEscalation();
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        armEscalation();
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
