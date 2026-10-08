// ---------------------------------------------------------------------------
// builtin-timer — deferred actions (set / cancel / list)
// --------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import type { TimerScheduler } from "../../timers/timer-scheduler";

const MAX_ACTIVE_PER_SESSION = 50;
const MIN_DURATION_S = 120; // Updated: 2 minutes
const MAX_DURATION_S = 30 * 24 * 60 * 60; // 30 days

/** Module-level ref set once at startup by the daemon. */
let schedulerRef: TimerScheduler | undefined;

export function setTimerScheduler(scheduler: TimerScheduler): void {
  schedulerRef = scheduler;
}

export function getTimerScheduler(): TimerScheduler | undefined {
  return schedulerRef;
}

export function register(registry: BuiltinToolRegistry): void {
  registry.register("timer", timerHandler);
}

async function timerHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  if (!schedulerRef) {
    return {
      resultJson: JSON.stringify({ error: "timer scheduler not available" }),
    };
  }
  const action = String(args.action ?? "");
  switch (action) {
    case "set":
      return timerSet(args, ctx, schedulerRef);
    case "cancel":
      return timerCancel(args, ctx, schedulerRef);
    case "list":
      return timerList(ctx, schedulerRef);
    default:
      return {
        resultJson: JSON.stringify({ error: `unknown action: ${action}` }),
      };
  }
}

function timerSet(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
  scheduler: TimerScheduler,
): { resultJson: string } {
  const label = String(args.label ?? "").trim();
  if (!label) {
    return { resultJson: JSON.stringify({ error: "label is required" }) };
  }

  const anchorRaw = args.anchor_session;
  let sessionAnchor: string | null = null;
  if (anchorRaw !== undefined && anchorRaw !== null && String(anchorRaw).trim() !== "") {
    const anchorId = String(anchorRaw).trim();
    const sess = ctx.db.prepare("SELECT status FROM sessions WHERE id = ?").get(anchorId) as
      | { status: string }
      | undefined;
    if (!sess) {
      return { resultJson: JSON.stringify({ error: `unknown session: ${anchorId}` }) };
    }
    if (sess.status === "terminated") {
      return { resultJson: JSON.stringify({ error: `session ${anchorId} is terminated` }) };
    }
    sessionAnchor = anchorId;
  }

  const atRaw = args.at;
  if (atRaw === undefined || atRaw === null || String(atRaw).trim() === "") {
    return {
      resultJson: JSON.stringify({
        error: "at is required (ISO 8601 datetime or relative duration like 2h, 30m, 90s, 1d)",
      }),
    };
  }

  const fireAt = parseFireAt(String(atRaw).trim());
  if (!fireAt) {
    return {
      resultJson: JSON.stringify({
        error:
          "invalid at value — use ISO 8601 datetime or relative duration (e.g. 30s, 5m, 2h, 1d)",
      }),
    };
  }

  // Enforce min/max duration
  const nowMs = Date.now();
  const fireMs = fireAt.getTime();
  const durationS = (fireMs - nowMs) / 1000;
  if (durationS < MIN_DURATION_S) {
    return {
      resultJson: JSON.stringify({
        error: `minimum timer duration is 2 minutes`, // Updated error message
      }),
    };
  }
  if (durationS > MAX_DURATION_S) {
    return {
      resultJson: JSON.stringify({
        error: `maximum timer duration is 30 days`,
      }),
    };
  }

  // Per-session cap
  const active = scheduler.countForSession(ctx.db, ctx.sessionId);
  if (active >= MAX_ACTIVE_PER_SESSION) {
    return {
      resultJson: JSON.stringify({
        error: `per-session limit of ${MAX_ACTIVE_PER_SESSION} active timers reached`,
      }),
    };
  }

  const id = randomUUID();
  const fireAtIso = fireAt.toISOString();
  const message =
    typeof args.message === "string" && args.message.trim() ? args.message.trim() : label;

  scheduler.schedule(ctx.db, {
    id,
    sessionId: ctx.sessionId,
    label,
    fireAt: fireAtIso,
    message,
    sessionAnchor,
  });

  const allTimers = scheduler.listForSession(ctx.db, ctx.sessionId);
  return {
    resultJson: JSON.stringify({
      ok: true,
      id,
      label,
      fireAt: fireAtIso,
      activeTimers: allTimers.map((t) => ({
        id: t.id,
        label: t.label,
        fireAt: t.fireAt,
        message: t.message,
        sessionAnchor: t.sessionAnchor,
      })),
    }),
  };
}

function timerCancel(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
  scheduler: TimerScheduler,
): { resultJson: string } {
  const id = String(args.id ?? "").trim();
  if (!id) {
    return { resultJson: JSON.stringify({ error: "id is required" }) };
  }

  // Verify the timer belongs to this session
  const row = ctx.db.prepare("SELECT session_id FROM timers WHERE id = ? AND fired = 0").get(id) as
    | { session_id: string }
    | undefined;
  if (!row) {
    return { resultJson: JSON.stringify({ ok: true, id, cancelled: false }) };
  }
  if (row.session_id !== ctx.sessionId) {
    return {
      resultJson: JSON.stringify({
        error: "timer belongs to a different session",
      }),
    };
  }

  const cancelled = scheduler.cancel(ctx.db, id);
  return { resultJson: JSON.stringify({ ok: true, id, cancelled }) };
}

function timerList(ctx: BuiltinToolContext, scheduler: TimerScheduler): { resultJson: string } {
  const timers = scheduler.listForSession(ctx.db, ctx.sessionId);
  return {
    resultJson: JSON.stringify({
      ok: true,
      timers: timers.map((t) => ({
        id: t.id,
        label: t.label,
        fireAt: t.fireAt,
        message: t.message,
        sessionAnchor: t.sessionAnchor,
      })),
    }),
  };
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const RELATIVE_RE =
  /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i;

function parseFireAt(raw: string): Date | undefined {
  // Try relative duration first
  const m = RELATIVE_RE.exec(raw);
  if (m) {
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    let seconds: number;
    if (unit.startsWith("s")) {
      seconds = value;
    } else if (unit.startsWith("m")) {
      seconds = value * 60;
    } else if (unit.startsWith("h")) {
      seconds = value * 3600;
    } else {
      // days
      seconds = value * 86400;
    }
    return new Date(Date.now() + seconds * 1000);
  }

  // Try ISO 8601
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d;
  }

  return undefined;
}
