// ---------------------------------------------------------------------------
// Managed Process — wraps a ChildProcess with state machine & lifecycle
// ---------------------------------------------------------------------------

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as http from "node:http";
import type {
  ProcessSpec,
  ProcessState,
  HealthCheck,
  ShutdownConfig,
} from "./types.js";
import { RingBuffer } from "./ring-buffer.js";

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ...fields, ts: new Date().toISOString() }) + "\n",
  );
}

/** Kill a process group (negative PID). Falls back to direct kill. */
function killPg(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

const DEFAULT_STDIO_MAX = 1024 * 1024; // 1 MB

export class ManagedProcess extends EventEmitter {
  readonly spec: ProcessSpec;

  private _state: ProcessState = "starting";
  private _child: ChildProcess | null = null;
  private _pid: number | undefined;
  private _restartCount = 0;
  private _lastExitCode: number | null = null;
  private _lastSignal: NodeJS.Signals | null = null;
  private _startedAt: number | null = null;
  private _consecutiveFailures = 0;

  private _stdoutBuf: RingBuffer;
  private _stderrBuf: RingBuffer;

  private _healthTimer: ReturnType<typeof setTimeout> | null = null;
  private _healthRetries = 0;
  private _restartTimer: ReturnType<typeof setTimeout> | null = null;
  private _runtimeTimer: ReturnType<typeof setTimeout> | null = null;
  private _resetTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopPromise: Promise<void> | null = null;
  private _stopResolve: (() => void) | null = null;
  private _stdoutMatchResolved = false;

  constructor(spec: ProcessSpec) {
    super();
    this.spec = spec;
    const maxBuf = spec.stdio?.maxBufferBytes ?? DEFAULT_STDIO_MAX;
    this._stdoutBuf = new RingBuffer(maxBuf);
    this._stderrBuf = new RingBuffer(maxBuf);
  }

  // -- Public getters -------------------------------------------------------

  get state(): ProcessState { return this._state; }
  get pid(): number | undefined { return this._pid; }
  get restartCount(): number { return this._restartCount; }
  get lastExitCode(): number | null { return this._lastExitCode; }
  get lastSignal(): NodeJS.Signals | null { return this._lastSignal; }

  get uptimeMs(): number {
    if (this._startedAt == null) return 0;
    return Date.now() - this._startedAt;
  }

  // -- Output access --------------------------------------------------------

  readOutput(stream: "stdout" | "stderr"): string {
    return stream === "stdout"
      ? this._stdoutBuf.readString()
      : this._stderrBuf.readString();
  }

  writeStdin(data: string | Buffer): void {
    if (!this._child?.stdin?.writable) {
      throw new Error(`stdin not writable for process ${this.spec.id}`);
    }
    this._child.stdin.write(data);
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Spawn the child process and begin lifecycle management. */
  async start(): Promise<void> {
    this._setState("starting");
    this._spawn();

    // If there's no health check, transition to running immediately
    if (!this.spec.health) {
      this._setState("running");
      this._startedAt = Date.now();
      this._scheduleResetTimer();
    } else {
      await this._runHealthCheck();
    }
  }

  /** Graceful stop: signal → grace → SIGKILL. Resolves when dead. */
  async stop(): Promise<void> {
    if (this._state === "dead") return;
    if (this._stopPromise) return this._stopPromise;

    this._stopPromise = new Promise<void>((resolve) => {
      this._stopResolve = resolve;
    });

    this._setState("stopping");
    this._clearTimers();

    if (!this._child || this._child.exitCode !== null) {
      this._finalize();
      return this._stopPromise;
    }

    const cfg: ShutdownConfig = this.spec.shutdown ?? {};
    const signal = cfg.signal ?? "SIGTERM";
    const graceMs = cfg.graceMs ?? 5000;

    // Run preStop command if configured
    if (cfg.preStop) {
      try {
        await this._runPreStop(cfg.preStop);
      } catch (err) {
        log("warn", "preStop command failed", { processId: this.spec.id, error: String(err) });
      }
    }

    killPg(this._child, signal);

    // Grace period → SIGKILL
    const graceTimer = setTimeout(() => {
      if (this._child && this._child.exitCode === null) {
        log("warn", "grace period expired, sending SIGKILL", { processId: this.spec.id });
        killPg(this._child!, "SIGKILL");
      }
    }, graceMs);

    // Wait for exit
    if (this._child.exitCode === null) {
      await new Promise<void>((resolve) => {
        this._child!.once("close", () => {
          clearTimeout(graceTimer);
          resolve();
        });
      });
    } else {
      clearTimeout(graceTimer);
    }

    this._finalize();
    return this._stopPromise;
  }

  /** Force kill (SIGKILL). */
  kill(): void {
    if (this._child && this._child.exitCode === null) {
      killPg(this._child, "SIGKILL");
    }
  }

  /** Stop then start again. */
  async restart(): Promise<void> {
    await this.stop();
    this._stopPromise = null;
    this._stopResolve = null;
    this._state = "starting"; // reset without emitting yet
    await this.start();
  }

  // -- Internal: spawning ---------------------------------------------------

  private _spawn(): void {
    const spec = this.spec;
    const stdioCfg = spec.stdio?.capture ?? "pipe";
    const stdinMode = spec.stdio?.stdin ? "pipe" : "ignore";

    const stdioArr: Array<"pipe" | "ignore" | "inherit"> =
      stdioCfg === "pipe"
        ? [stdinMode as "pipe" | "ignore", "pipe", "pipe"]
        : stdioCfg === "inherit"
          ? [stdinMode as "pipe" | "ignore", "inherit", "inherit"]
          : [stdinMode as "pipe" | "ignore", "ignore", "ignore"];

    const opts: Parameters<typeof spawn>[2] = {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: stdioArr,
      detached: true,
    };

    if (spec.uid != null) (opts as Record<string, unknown>).uid = spec.uid;
    if (spec.gid != null) (opts as Record<string, unknown>).gid = spec.gid;

    const child = spawn(spec.command, spec.args ?? [], opts);
    this._child = child;
    this._pid = child.pid;
    this._stdoutMatchResolved = false;

    log("info", "process spawned", { processId: spec.id, pid: child.pid });

    // Pipe stdout/stderr into ring buffers
    child.stdout?.on("data", (chunk: Buffer) => {
      this._stdoutBuf.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      this.emit("stdout", chunk);

      // stdout-match health check
      if (
        this.spec.health?.kind === "stdout-match" &&
        !this._stdoutMatchResolved &&
        this._state === "starting"
      ) {
        const pattern = this.spec.health.pattern;
        if (this._stdoutBuf.readString().includes(pattern)) {
          this._stdoutMatchResolved = true;
          this._onHealthy();
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      this._stderrBuf.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      this.emit("stderr", chunk);
    });

    child.on("error", (err) => {
      log("error", "process error", { processId: spec.id, error: String(err) });
    });

    child.on("close", (code, signal) => {
      this._lastExitCode = code;
      this._lastSignal = signal as NodeJS.Signals | null;
      log("info", "process exited", {
        processId: spec.id,
        exitCode: code,
        signal,
        state: this._state,
      });
      this._onExit(code, signal as NodeJS.Signals | null);
    });

    // Runtime limit
    if (spec.limits?.maxRuntimeSeconds && spec.limits.maxRuntimeSeconds > 0) {
      this._runtimeTimer = setTimeout(() => {
        log("warn", "runtime limit exceeded", { processId: spec.id });
        this.stop();
      }, spec.limits.maxRuntimeSeconds * 1000);
    }
  }

  // -- Internal: state machine ----------------------------------------------

  private _setState(newState: ProcessState): void {
    const old = this._state;
    if (old === newState) return;
    this._state = newState;
    log("info", "state change", {
      processId: this.spec.id,
      state: newState,
      prevState: old,
      pid: this._pid,
      restartCount: this._restartCount,
    });
    this.emit("state-change", newState, old);
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this._clearTimers();
    this.emit("exit", code, signal);

    if (this._state === "stopping") {
      // Expected stop — go to dead
      this._finalize();
      return;
    }

    this._setState("exited");

    // Decide whether to restart
    const policy = this.spec.restart;
    const shouldRestart =
      policy.mode === "always" ||
      (policy.mode === "on-failure" && code !== 0);

    const maxRetries = policy.maxRetries ?? 5;

    if (shouldRestart && this._consecutiveFailures < maxRetries) {
      this._scheduleRestart();
    } else {
      this._setState("dead");
      this._resolveStop();
    }
  }

  private _finalize(): void {
    this._clearTimers();
    this._setState("dead");
    this._child = null;
    this._pid = undefined;
    this._resolveStop();
  }

  private _resolveStop(): void {
    if (this._stopResolve) {
      this._stopResolve();
      this._stopResolve = null;
    }
  }

  // -- Internal: restart logic ----------------------------------------------

  private _scheduleRestart(): void {
    this._consecutiveFailures++;
    const policy = this.spec.restart;
    const initial = policy.initialDelayMs ?? 1000;
    const multiplier = policy.backoffMultiplier ?? 2;
    const maxDelay = policy.maxDelayMs ?? 30000;

    const delay = Math.min(
      initial * Math.pow(multiplier, this._consecutiveFailures - 1),
      maxDelay,
    );

    log("info", "scheduling restart", {
      processId: this.spec.id,
      attempt: this._consecutiveFailures,
      delayMs: delay,
    });

    this._restartTimer = setTimeout(async () => {
      this._restartCount++;
      this._stdoutBuf.clear();
      this._stderrBuf.clear();
      try {
        await this.start();
      } catch (err) {
        log("error", "restart failed", { processId: this.spec.id, error: String(err) });
        this._setState("failed");
      }
    }, delay);
  }

  private _scheduleResetTimer(): void {
    const resetAfter = this.spec.restart.resetAfterMs ?? 60000;
    if (resetAfter > 0) {
      this._resetTimer = setTimeout(() => {
        if (this._state === "running") {
          this._consecutiveFailures = 0;
        }
      }, resetAfter);
    }
  }

  // -- Internal: health checks ----------------------------------------------

  private async _runHealthCheck(): Promise<void> {
    const hc = this.spec.health;
    if (!hc) return;

    if (hc.kind === "stdout-match") {
      // stdout-match is handled reactively in the stdout data handler
      const timeoutMs = hc.timeoutMs ?? 30000;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this._state === "starting") {
            log("error", "stdout-match health check timed out", { processId: this.spec.id });
            this._setState("failed");
            reject(new Error(`stdout-match timeout for ${this.spec.id}`));
          }
        }, timeoutMs);

        const check = () => {
          if (this._stdoutMatchResolved || this._state !== "starting") {
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    // Polling health checks (tcp, http, exec)
    const intervalMs = ("intervalMs" in hc ? hc.intervalMs : undefined) ?? 1000;
    const timeoutMs = ("timeoutMs" in hc ? hc.timeoutMs : undefined) ?? 5000;
    const maxRetries = ("retries" in hc ? hc.retries : undefined) ?? 10;

    return new Promise<void>((resolve, reject) => {
      this._healthRetries = 0;

      const attempt = async () => {
        if (this._state !== "starting") {
          resolve();
          return;
        }

        try {
          const ok = await this._probeHealth(hc, timeoutMs);
          if (ok) {
            this._onHealthy();
            resolve();
            return;
          }
        } catch {
          // probe failed
        }

        this._healthRetries++;
        if (this._healthRetries >= maxRetries) {
          log("error", "health check retries exhausted", { processId: this.spec.id });
          this._setState("failed");
          reject(new Error(`health check failed for ${this.spec.id}`));
          return;
        }

        this._healthTimer = setTimeout(attempt, intervalMs);
      };

      // First attempt after a short delay to let the process start
      this._healthTimer = setTimeout(attempt, intervalMs);
    });
  }

  private _onHealthy(): void {
    if (this._state !== "starting") return;
    this._setState("running");
    this._startedAt = Date.now();
    this._scheduleResetTimer();
  }

  private _probeHealth(hc: HealthCheck, timeoutMs: number): Promise<boolean> {
    switch (hc.kind) {
      case "tcp":
        return this._probeTcp(hc.port, hc.host ?? "127.0.0.1", timeoutMs);
      case "http":
        return this._probeHttp(hc.url, hc.expectedStatus ?? 200, timeoutMs);
      case "exec":
        return this._probeExec(hc.command, hc.args ?? [], timeoutMs);
      default:
        return Promise.resolve(true);
    }
  }

  private _probeTcp(port: number, host: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection({ port, host, timeout: timeoutMs });
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.on("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  private _probeHttp(url: string, expectedStatus: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume(); // drain
        resolve(res.statusCode === expectedStatus);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private _probeExec(command: string, args: string[], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const child = execFile(command, args, { timeout: timeoutMs }, (err) => {
        resolve(!err);
      });
      child.on("error", () => resolve(false));
    });
  }

  // -- Internal: preStop command --------------------------------------------

  private _runPreStop(cfg: { command: string; args?: string[]; timeoutMs?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        cfg.command,
        cfg.args ?? [],
        { timeout: cfg.timeoutMs ?? 5000 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
      child.on("error", reject);
    });
  }

  // -- Internal: timer cleanup ----------------------------------------------

  private _clearTimers(): void {
    if (this._healthTimer) { clearTimeout(this._healthTimer); this._healthTimer = null; }
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._runtimeTimer) { clearTimeout(this._runtimeTimer); this._runtimeTimer = null; }
    if (this._resetTimer) { clearTimeout(this._resetTimer); this._resetTimer = null; }
  }
}
