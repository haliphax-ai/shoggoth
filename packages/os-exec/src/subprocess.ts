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
    // Buffer string chunks in an array and join at the end to avoid
    // O(n²) repeated string concatenation.
    const chunks: string[] = [];
    stream.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? c : c.toString("utf8"));
    });
    stream.on("end", () => resolve(chunks.join("")));
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
  const pid = child.pid;

  // Can't kill the process group without a PID; fall back to the child directly.
  if (pid !== undefined) {
    try {
      // Kill the entire process group (negative PID)
      process.kill(-pid, signal);
      return;
    } catch {
      // Group may already be dead — fall through to the direct child kill.
    }
  }

  // Fallback: kill just the child (group kill failed, or no PID available).
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

/**
 * Low-level spawn that returns the raw ChildProcess.
 * Used by `runAsUser` (foreground) for one-shot tool exec.
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
  // Detach from the Node.js event loop so the child doesn't keep the
  // process alive.  libuv still tracks and reaps the child via SIGCHLD.
  child.unref();

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
