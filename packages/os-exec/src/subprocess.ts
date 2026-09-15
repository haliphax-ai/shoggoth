import { spawn, type ChildProcess } from "node:child_process";

export interface RunAsUserResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when the process was killed because it exceeded the timeout. */
  timedOut?: boolean;
}

export interface RunAsUserOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  uid: number;
  gid: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Maximum wall-clock execution time in seconds.
   * The process receives SIGTERM; if it hasn't exited after a 5-second grace
   * period it is sent SIGKILL.
   */
  timeout?: number;
}

/** Grace period (ms) between SIGTERM and SIGKILL when a timeout fires. */
const TIMEOUT_GRACE_MS = 5_000;

function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * Kill a child process and its entire process group.
 * When spawned with `detached: true`, the child leads its own process group,
 * so killing with `-pid` ensures shell children (e.g. `sh -c "sleep 60"`)
 * are also terminated.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Kill the entire process group (negative PID)
    process.kill(-child.pid!, signal);
  } catch {
    // Fallback: kill just the child (group may already be dead)
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Low-level spawn that returns the raw ChildProcess.
 * Used by both `runAsUser` (foreground) and `spawnAsUser` (background).
 *
 * Spawns with `detached: true` so the child gets its own process group,
 * enabling clean group-kill on timeout.
 */
function spawnChild(options: RunAsUserOptions): ChildProcess {
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    uid: options.uid,
    gid: options.gid,
    stdio: options.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
    detached: true,
  });

  if (child.stdin && options.stdin !== undefined) {
    child.stdin.write(options.stdin, "utf8");
    child.stdin.end();
  }

  return child;
}

/**
 * Spawn a subprocess with POSIX `uid` / `gid` (Node passes these to `posix_spawn` on Linux).
 * The parent should remain privileged; the child runs as the agent identity for kernel DAC.
 *
 * When `timeout` is set, the process is sent SIGTERM after the specified number of seconds.
 * If it hasn't exited after a 5-second grace period, SIGKILL is sent.
 */
export function runAsUser(options: RunAsUserOptions): Promise<RunAsUserResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(options);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      reject(err);
    });

    // Set up timeout if requested
    if (options.timeout != null && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
        // Grace period — escalate to SIGKILL if still alive
        killTimer = setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, TIMEOUT_GRACE_MS);
      }, options.timeout * 1_000);
    }

    const outP = collectStream(child.stdout);
    const errP = collectStream(child.stderr);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      void Promise.all([outP, errP])
        .then(([stdout, stderr]) => {
          resolve({
            stdout,
            stderr,
            exitCode,
            signal,
            timedOut: timedOut || undefined,
          });
        })
        .catch(reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Background / yield-based spawning
// ---------------------------------------------------------------------------

/** Handle returned when a process is spawned in the background. */
export interface BackgroundHandle {
  /** Unique session identifier. */
  sessionId: string;
  /** OS process ID. */
  pid: number;
  /** The underlying ChildProcess (for polling / killing). */
  child: ChildProcess;
  /** Accumulated stdout chunks. */
  stdoutChunks: Buffer[];
  /** Accumulated stderr chunks. */
  stderrChunks: Buffer[];
  /** Set when the process exits. */
  exitCode: number | null;
  /** Set when the process exits via signal. */
  signal: NodeJS.Signals | null;
  /** True once the process has exited. */
  exited: boolean;
  /** True if killed by timeout. */
  timedOut: boolean;
  /** Set when the process emits an error (e.g. spawn failure). */
  error: Error | null;
  /** Resolves when the process exits. */
  done: Promise<void>;
}

let sessionCounter = 0;

/** Generate a short, unique session ID. */
function nextSessionId(): string {
  return `exec-${Date.now().toString(36)}-${(++sessionCounter).toString(36)}`;
}

/**
 * Spawn a process in the background and return a handle immediately.
 * The caller can poll the handle's `exited` flag, read accumulated output,
 * or await `handle.done`.
 *
 * If `timeout` is set on the options, the process is killed after that many seconds.
 */
export function spawnAsUser(options: RunAsUserOptions): BackgroundHandle {
  const child = spawnChild(options);
  const handle: BackgroundHandle = {
    sessionId: nextSessionId(),
    pid: child.pid!,
    child,
    stdoutChunks: [],
    stderrChunks: [],
    exitCode: null,
    signal: null,
    exited: false,
    timedOut: false,
    error: null,
    done: null as unknown as Promise<void>,
  };

  // Accumulate output
  child.stdout?.on("data", (c: Buffer | string) => {
    handle.stdoutChunks.push(typeof c === "string" ? Buffer.from(c) : c);
  });
  child.stderr?.on("data", (c: Buffer | string) => {
    handle.stderrChunks.push(typeof c === "string" ? Buffer.from(c) : c);
  });

  // Timeout handling
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  if (options.timeout != null && options.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      handle.timedOut = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, TIMEOUT_GRACE_MS);
    }, options.timeout * 1_000);
  }

  // Completion promise
  handle.done = new Promise<void>((resolve) => {
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      handle.exitCode = exitCode;
      handle.signal = signal;
      handle.exited = true;
      resolve();
    });

    // Handle spawn errors (e.g. binary not found). When the process fails to
    // start, the "close" event may never fire, which would leave the done
    // promise hanging forever. Instead, store the error and resolve so callers
    // aren't blocked.
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      handle.error = err;
      handle.exited = true;
      resolve();
    });
  });

  return handle;
}

/** Read all accumulated output from a BackgroundHandle as a string. */
export function readHandleOutput(handle: BackgroundHandle, stream: "stdout" | "stderr"): string {
  const chunks = stream === "stdout" ? handle.stdoutChunks : handle.stderrChunks;
  return Buffer.concat(chunks).toString("utf8");
}
