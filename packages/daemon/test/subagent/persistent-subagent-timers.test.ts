import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionStore } from "../../src/sessions/session-store";
import {
  armPersistentSubagentInactivityTimer,
  clearAllPersistentSubagentInactivityTimers,
  clearPersistentSubagentInactivityTimer,
  touchPersistentSubagentInactivityTimer,
} from "../../src/subagent/persistent-subagent-timers";
import { SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS } from "../../src/subagent/subagent-constants";

function stubSessions() {
  const updates: Array<{ id: string; patch: { subagentExpiresAtMs?: number | null } }> = [];
  const sessions = {
    update: (id: string, patch: { subagentExpiresAtMs?: number | null }) => {
      updates.push({ id, patch });
    },
  } as unknown as SessionStore;
  return { sessions, updates };
}

describe("persistent-subagent-timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllPersistentSubagentInactivityTimers();
  });

  afterEach(() => {
    clearAllPersistentSubagentInactivityTimers();
    vi.useRealTimers();
  });

  it("arms with the default inactivity window and persists the expiry", () => {
    const { sessions, updates } = stubSessions();
    const timeouts: string[] = [];
    const started = Date.now();

    const { expiresAtMs } = armPersistentSubagentInactivityTimer(
      { sessions, onTimeout: (sid) => timeouts.push(sid) },
      "s1",
    );

    expect(expiresAtMs).toBe(started + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS);
    expect(updates).toEqual([
      {
        id: "s1",
        patch: { subagentExpiresAtMs: started + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS },
      },
    ]);

    vi.advanceTimersByTime(SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS - 1);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timeouts).toEqual(["s1"]);
  });

  it("honors an explicit timeoutMs and an absolute expiresAtMs", () => {
    const { sessions, updates } = stubSessions();
    const timeouts: string[] = [];
    const started = Date.now();

    const { expiresAtMs } = armPersistentSubagentInactivityTimer(
      { sessions, onTimeout: (sid) => timeouts.push(sid) },
      "s2",
      { timeoutMs: 1_000, expiresAtMs: started + 5_000 },
    );

    expect(expiresAtMs).toBe(started + 5_000);
    expect(updates.at(-1)?.patch.subagentExpiresAtMs).toBe(started + 5_000);
    vi.advanceTimersByTime(4_999);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timeouts).toEqual(["s2"]);
  });

  it("touch re-arms the timer, persists the new expiry, and reuses the armed window", () => {
    const { sessions, updates } = stubSessions();
    const timeouts: string[] = [];
    const started = Date.now();

    armPersistentSubagentInactivityTimer(
      { sessions, onTimeout: (sid) => timeouts.push(sid) },
      "s3",
      { timeoutMs: 1_000 },
    );
    expect(updates.at(-1)?.patch.subagentExpiresAtMs).toBe(started + 1_000);

    vi.advanceTimersByTime(600);
    touchPersistentSubagentInactivityTimer("s3");
    expect(updates.at(-1)?.patch.subagentExpiresAtMs).toBe(started + 600 + 1_000);

    // The original window elapsed — the re-armed timer must not have fired.
    vi.advanceTimersByTime(500);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(timeouts).toEqual(["s3"]);
  });

  it("touch is a no-op for sessions without an armed timer", () => {
    const { updates } = stubSessions();
    touchPersistentSubagentInactivityTimer("unknown-session");
    expect(updates).toEqual([]);
  });

  it("dispose clears the timer; a second arm replaces the first", () => {
    const { sessions } = stubSessions();
    const timeouts: string[] = [];
    const deps = { sessions, onTimeout: (sid: string) => timeouts.push(sid) };

    const first = armPersistentSubagentInactivityTimer(deps, "s4", { timeoutMs: 1_000 });
    first.dispose();
    armPersistentSubagentInactivityTimer(deps, "s4", { timeoutMs: 2_000 });

    vi.advanceTimersByTime(1_000);
    expect(timeouts).toEqual([]); // disposed timer never fired
    vi.advanceTimersByTime(1_000);
    expect(timeouts).toEqual(["s4"]);
  });

  it("clearPersistentSubagentInactivityTimer stops an armed timer", () => {
    const { sessions } = stubSessions();
    const timeouts: string[] = [];
    armPersistentSubagentInactivityTimer(
      { sessions, onTimeout: (sid) => timeouts.push(sid) },
      "s5",
      { timeoutMs: 1_000 },
    );
    clearPersistentSubagentInactivityTimer("s5");
    vi.advanceTimersByTime(10_000);
    expect(timeouts).toEqual([]);
  });
});
