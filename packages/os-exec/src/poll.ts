import { getProcessManager } from "./tools";
import { isTerminal } from "./util";
import type { ManagedProcess } from "@shoggoth/procman";

// ---------------------------------------------------------------------------
// Poll tool — check status and output of a background process by PID
// ---------------------------------------------------------------------------

/** Input parameters for the poll tool. */
export interface PollOptions {
  /** Process ID of the background process to check. */
  pid: number;
  /**
   * Maximum milliseconds to wait for the process to finish before returning
   * current status. 0 (default) returns immediately.
   */
  timeout?: number;
  /**
   * When true, return stdout and stderr as separate fields instead of
   * combined `output`.
   */
  streams?: boolean;
  /** Return only the last N lines of output. */
  tail?: number;
  /**
   * Return only output captured after this byte offset. Enables incremental
   * reads across multiple polls.
   */
  since?: number;
}

/** Base fields shared by all poll responses. */
interface PollResultBase {
  pid: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: string;
  runtimeMs: number;
  /**
   * True when the poll waited out its full timeout with the process still
   * running (timeout expired without the process exiting). Omitted when the
   * poll returned instantly or the process exited during the wait.
   */
  waited?: boolean;
  /** Actual milliseconds waited before returning (only set with `waited`). */
  waitedMs?: number;
}

/** Combined-output response (streams: false, the default). */
export interface PollCombinedResult extends PollResultBase {
  output: string;
  outputBytes: number;
  truncated: boolean;
}

/** Split-stream response (streams: true). */
export interface PollSplitResult extends PollResultBase {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type PollResult = PollCombinedResult | PollSplitResult;

/** Error response when the PID is not tracked. */
export interface PollError {
  error: string;
}

export type PollResponse = PollResult | PollError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix and separator of the creation sequence embedded in exec spec IDs. */
const PROC_SEQ_PREFIX = "exec-";
const PROC_SEQ_SEP = "-";

/**
 * Extract the monotonic creation sequence from an exec spec ID
 * (`exec-<seq>-<uuid>`). Returns -1 when the ID predates this format, so such
 * specs lose recency comparisons against sequenced ones.
 */
function specCreationSeq(id: string): number {
  if (!id.startsWith(PROC_SEQ_PREFIX)) return -1;
  const rest = id.slice(PROC_SEQ_PREFIX.length);
  const end = rest.indexOf(PROC_SEQ_SEP);
  if (end <= 0) return -1;
  const seqStr = rest.slice(0, end);
  if (!/^\d+$/.test(seqStr)) return -1;
  return Number(seqStr);
}

/**
 * Find the most recent process matching a given PID via procman.
 * Handles PID reuse by preferring the most recently created session.
 *
 * Session IDs embed a monotonic creation sequence (see `nextProcmanId` in
 * tools.ts), so lexicographic ID comparison orders sessions by creation time.
 * Specs without a sequence — from other producers or older versions — fall
 * back to their spec ID.
 */
function findProcessByPid(pid: number): ManagedProcess | undefined {
  const pm = getProcessManager();
  if (!pm) return undefined;

  const managed = pm.listByOwner({ kind: "agent-tool", scopeId: "exec" });
  let bestMp: ManagedProcess | undefined;
  let bestSeq = -1;
  for (const mp of managed) {
    if (mp.pid !== pid) continue;
    const seq = specCreationSeq(mp.spec.id);
    if (!bestMp || seq > bestSeq || (seq === bestSeq && mp.spec.id > bestMp.spec.id)) {
      bestMp = mp;
      bestSeq = seq;
    }
  }
  return bestMp;
}

/**
 * Apply `since` (byte offset) and `tail` (last N lines) filters to raw output.
 *
 * Returns { text, totalBytes, truncated }.
 * - `totalBytes` is the total byte count of the stream (before slicing).
 * - `truncated` is true when `since` or `tail` caused output to be trimmed.
 */
function filterRawOutput(
  raw: string,
  since: number | undefined,
  tail: number | undefined,
): { text: string; totalBytes: number; truncated: boolean } {
  const totalBytes = Buffer.byteLength(raw, "utf8");

  // `tail` takes precedence over `since` (per proposal)
  if (tail !== undefined) {
    // Walk backward counting newlines to find where the last `tail` lines begin,
    // avoiding the O(n) split+slice+join on large outputs.
    let pos = raw.length;
    let newlinesFound = 0;
    while (pos > 0) {
      pos--;
      if (raw[pos] === "\n") {
        newlinesFound++;
        if (newlinesFound === tail) break;
      }
    }
    if (newlinesFound < tail) {
      // Fewer lines than requested — return entire output.
      return { text: raw, totalBytes, truncated: false };
    }
    const text = raw.slice(pos + 1);
    return { text, totalBytes, truncated: true };
  }

  if (since !== undefined) {
    if (since >= totalBytes) {
      return { text: "", totalBytes, truncated: false };
    }
    const buf = Buffer.from(raw, "utf8");
    const text = buf.subarray(since).toString("utf8");
    return { text, totalBytes, truncated: since > 0 };
  }

  return { text: raw, totalBytes, truncated: false };
}

/**
 * Get filtered output from a procman ManagedProcess.
 */
function getFilteredManagedOutput(
  mp: ManagedProcess,
  stream: "stdout" | "stderr",
  since: number | undefined,
  tail: number | undefined,
): { text: string; totalBytes: number; truncated: boolean } {
  const raw = mp.readOutput(stream);
  return filterRawOutput(raw, since, tail);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePollOptions(opts: PollOptions): void {
  if (opts.pid === undefined || opts.pid === null || typeof opts.pid !== "number") {
    throw new Error("`pid` is required and must be a number.");
  }
  if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
    throw new Error("`pid` must be a positive integer.");
  }
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || opts.timeout < 0) {
      throw new Error("`timeout` must be a non-negative number (milliseconds).");
    }
  }
  if (opts.tail !== undefined) {
    if (typeof opts.tail !== "number" || !Number.isInteger(opts.tail) || opts.tail < 1) {
      throw new Error("`tail` must be a positive integer.");
    }
  }
  if (opts.since !== undefined) {
    if (typeof opts.since !== "number" || opts.since < 0) {
      throw new Error("`since` must be a non-negative number.");
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Poll a background process by PID — check its status and retrieve output.
 *
 * Queries procman for the process. Returns an error if the PID is not tracked.
 */
export async function toolPoll(opts: PollOptions): Promise<PollResponse> {
  validatePollOptions(opts);

  const mp = findProcessByPid(opts.pid);
  if (!mp) {
    return { error: `no tracked process with pid ${opts.pid}` };
  }

  return pollManagedProcess(mp, opts);
}

// ---------------------------------------------------------------------------
// Procman ManagedProcess polling
// ---------------------------------------------------------------------------

/**
 * Wait up to `timeoutMs` for a managed process to reach a terminal state;
 * resolves via `state-change` listener, post-registration re-check, or
 * timeout — whichever fires first. The timeout timer is always cleared
 * when the exit path wins, so no dangling timer holds the event loop.
 *
 * Returns true only when the timeout actually expired with the process
 * still running; callers use this to decide whether `waited` is meaningful
 * (an instant exit resolves the wait without any real waiting).
 */
function waitForProcessExitOrTimeout(mp: ManagedProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    /** Settle the wait exactly once; cleanup runs on every path. */
    const finish = (didTimeout: boolean) => {
      clearTimeout(timeoutTimer);
      resolve(didTimeout);
    };

    const check = (_state: string) => {
      if (isTerminal(mp.state)) {
        mp.removeListener("state-change", check);
        finish(false);
      }
    };

    mp.on("state-change", check);
    if (isTerminal(mp.state)) {
      // Already exited while we were setting up.
      mp.removeListener("state-change", check);
      finish(false);
      return;
    }

    timeoutTimer = setTimeout(() => {
      mp.removeListener("state-change", check);
      finish(true);
    }, timeoutMs);
  });
}

async function pollManagedProcess(mp: ManagedProcess, opts: PollOptions): Promise<PollResult> {
  const timeoutMs = opts.timeout ?? 0;
  let waited = false;
  let waitedMs = 0;

  const isExited = isTerminal(mp.state);

  // If the process is still running and timeout > 0, wait for it
  if (!isExited && timeoutMs > 0) {
    const waitStart = Date.now();
    const timedOut = await waitForProcessExitOrTimeout(mp, timeoutMs);

    // `waited` is only meaningful when the timeout path actually fired —
    // an instant exit resolves the wait without any real waiting.
    if (timedOut) {
      waitedMs = Date.now() - waitStart;
      waited = true;
    }
  }

  const runtimeMs = mp.uptimeMs;
  const nowExited = isTerminal(mp.state);

  // Build base result
  const base: PollResultBase = {
    pid: opts.pid,
    status: nowExited ? "exited" : "running",
    runtimeMs,
  };

  if (nowExited) {
    base.exitCode = mp.lastExitCode ?? undefined;
    if (mp.lastSignal) {
      base.signal = mp.lastSignal;
    }
  }

  if (waited) {
    base.waited = true;
    base.waitedMs = waitedMs;
  }

  // Build output fields
  if (opts.streams) {
    const out = getFilteredManagedOutput(mp, "stdout", opts.since, opts.tail);
    const err = getFilteredManagedOutput(mp, "stderr", opts.since, opts.tail);
    return {
      ...base,
      stdout: out.text,
      stderr: err.text,
      stdoutBytes: out.totalBytes,
      stderrBytes: err.totalBytes,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    } as PollSplitResult;
  }

  // Combined output
  const outData = getFilteredManagedOutput(mp, "stdout", opts.since, opts.tail);
  const errData = getFilteredManagedOutput(mp, "stderr", opts.since, opts.tail);
  const combinedText = outData.text + errData.text;
  const combinedBytes = outData.totalBytes + errData.totalBytes;
  const combinedTruncated = outData.truncated || errData.truncated;

  return {
    ...base,
    output: combinedText,
    outputBytes: combinedBytes,
    truncated: combinedTruncated,
  } as PollCombinedResult;
}
