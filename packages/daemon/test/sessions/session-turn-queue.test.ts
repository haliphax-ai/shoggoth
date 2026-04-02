import { describe, it, expect, beforeEach } from "vitest";
import { TieredTurnQueue, TurnDroppedError } from "../../src/sessions/session-turn-queue";

describe("TieredTurnQueue", () => {
  let q: TieredTurnQueue;

  beforeEach(() => {
    q = new TieredTurnQueue(3);
  });

  describe("basic enqueue and execution", () => {
    it("executes a single user turn", async () => {
      let ran = false;
      await q.enqueue("s1", "user", "user message", async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("executes a single system turn", async () => {
      let ran = false;
      await q.enqueue("s1", "system", "heartbeat", async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    it("serializes turns for the same session", async () => {
      const order: number[] = [];
      let resolve1!: () => void;
      const gate1 = new Promise<void>((r) => { resolve1 = r; });

      const p1 = q.enqueue("s1", "user", "msg1", async () => {
        await gate1;
        order.push(1);
      });
      const p2 = q.enqueue("s1", "user", "msg2", async () => {
        order.push(2);
      });

      // p2 should not run until p1 completes
      expect(order).toEqual([]);
      resolve1();
      await p1;
      await p2;
      expect(order).toEqual([1, 2]);
    });

    it("runs different sessions in parallel", async () => {
      let resolve1!: () => void;
      const gate1 = new Promise<void>((r) => { resolve1 = r; });
      let s2Started = false;

      const p1 = q.enqueue("s1", "user", "msg", async () => {
        await gate1;
      });
      const p2 = q.enqueue("s2", "user", "msg", async () => {
        s2Started = true;
      });

      await p2;
      expect(s2Started).toBe(true);
      resolve1();
      await p1;
    });
  });

  describe("priority ordering", () => {
    it("system entries run before user entries", async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      // Block the queue with a running turn
      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      // Queue up entries while blocked
      const pUser = q.enqueue("s1", "user", "user msg", async () => {
        order.push("user");
      });
      const pSys = q.enqueue("s1", "system", "heartbeat", async () => {
        order.push("system");
      });

      resolveFirst();
      await p0;
      await pSys;
      await pUser;
      expect(order).toEqual(["system", "user"]);
    });

    it("multiple system entries run before user entries", async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const pU = q.enqueue("s1", "user", "user", async () => {
        order.push("user");
      });
      const pS1 = q.enqueue("s1", "system", "sys1", async () => {
        order.push("sys1");
      });
      const pS2 = q.enqueue("s1", "system", "sys2", async () => {
        order.push("sys2");
      });

      resolveFirst();
      await Promise.all([p0, pU, pS1, pS2]);
      // sys1, sys2 first, then anti-starvation kicks in at threshold=3 but we only have 2 system
      expect(order).toEqual(["sys1", "sys2", "user"]);
    });
  });

  describe("anti-starvation", () => {
    it("promotes a normal entry after N consecutive high-priority turns", async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      // Queue 4 system + 1 user. With threshold=3, after 3 system turns the user should run.
      const pU = q.enqueue("s1", "user", "user", async () => {
        order.push("user");
      });
      const pS1 = q.enqueue("s1", "system", "s1", async () => { order.push("s1"); });
      const pS2 = q.enqueue("s1", "system", "s2", async () => { order.push("s2"); });
      const pS3 = q.enqueue("s1", "system", "s3", async () => { order.push("s3"); });
      const pS4 = q.enqueue("s1", "system", "s4", async () => { order.push("s4"); });

      resolveFirst();
      await Promise.all([p0, pU, pS1, pS2, pS3, pS4]);
      // s1, s2, s3 (threshold reached), user, s4
      expect(order).toEqual(["s1", "s2", "s3", "user", "s4"]);
    });

    it("skips starvation check when normal queue is empty", async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const pS1 = q.enqueue("s1", "system", "s1", async () => { order.push("s1"); });
      const pS2 = q.enqueue("s1", "system", "s2", async () => { order.push("s2"); });
      const pS3 = q.enqueue("s1", "system", "s3", async () => { order.push("s3"); });
      const pS4 = q.enqueue("s1", "system", "s4", async () => { order.push("s4"); });

      resolveFirst();
      await Promise.all([p0, pS1, pS2, pS3, pS4]);
      expect(order).toEqual(["s1", "s2", "s3", "s4"]);
    });

    it("resets counter after promoting a normal entry", async () => {
      const q2 = new TieredTurnQueue(2);
      const order: string[] = [];
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q2.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const pU1 = q2.enqueue("s1", "user", "u1", async () => { order.push("u1"); });
      const pU2 = q2.enqueue("s1", "user", "u2", async () => { order.push("u2"); });
      const pS1 = q2.enqueue("s1", "system", "s1", async () => { order.push("s1"); });
      const pS2 = q2.enqueue("s1", "system", "s2", async () => { order.push("s2"); });
      const pS3 = q2.enqueue("s1", "system", "s3", async () => { order.push("s3"); });
      const pS4 = q2.enqueue("s1", "system", "s4", async () => { order.push("s4"); });

      resolveFirst();
      await Promise.all([p0, pU1, pU2, pS1, pS2, pS3, pS4]);
      // threshold=2: s1, s2, u1 (starvation), s3, s4, u2 (starvation)
      expect(order).toEqual(["s1", "s2", "u1", "s3", "s4", "u2"]);
    });
  });

  describe("getDepth", () => {
    it("returns zeros for unknown session", () => {
      expect(q.getDepth("unknown")).toEqual({ system: 0, user: 0 });
    });

    it("reflects queued entries", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      q.enqueue("s1", "system", "sys", async () => {}).catch(() => {});
      q.enqueue("s1", "user", "usr", async () => {}).catch(() => {});

      expect(q.getDepth("s1")).toEqual({ system: 1, user: 1 });

      q.clear("s1");
      resolveFirst();
      await p0;
    });
  });

  describe("listQueued", () => {
    it("returns empty for unknown session", () => {
      expect(q.listQueued("unknown")).toEqual([]);
    });

    it("lists entries filtered by priority", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      q.enqueue("s1", "system", "heartbeat", async () => {}).catch(() => {});
      q.enqueue("s1", "user", "msg", async () => {}).catch(() => {});

      const sysEntries = q.listQueued("s1", "system");
      expect(sysEntries).toHaveLength(1);
      expect(sysEntries[0].label).toBe("heartbeat");

      const userEntries = q.listQueued("s1", "user");
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].label).toBe("msg");

      const all = q.listQueued("s1");
      expect(all).toHaveLength(2);

      q.clear("s1");
      resolveFirst();
      await p0;
    });
  });

  describe("removeById", () => {
    it("removes entries by id and rejects their promises", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const pSys = q.enqueue("s1", "system", "heartbeat", async () => {});
      const entries = q.listQueued("s1", "system");
      expect(entries).toHaveLength(1);

      const removed = q.removeById("s1", [entries[0].id]);
      expect(removed).toBe(1);
      expect(q.getDepth("s1")).toEqual({ system: 0, user: 0 });

      await expect(pSys).rejects.toThrow(TurnDroppedError);

      resolveFirst();
      await p0;
    });
  });

  describe("removeByRange", () => {
    it("removes entries by index range within a priority", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const p1 = q.enqueue("s1", "system", "s1", async () => {});
      const p2 = q.enqueue("s1", "system", "s2", async () => {});
      const p3 = q.enqueue("s1", "system", "s3", async () => {});

      const removed = q.removeByRange("s1", "system", 0, 1);
      expect(removed).toBe(2);
      expect(q.getDepth("s1")).toEqual({ system: 1, user: 0 });

      await expect(p1).rejects.toThrow(TurnDroppedError);
      await expect(p2).rejects.toThrow(TurnDroppedError);

      q.clear("s1");
      resolveFirst();
      await p0;
      await p3.catch(() => {});
    });
  });

  describe("removeByCount", () => {
    it("removes first N entries from a priority", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const p1 = q.enqueue("s1", "user", "u1", async () => {});
      const p2 = q.enqueue("s1", "user", "u2", async () => {});
      q.enqueue("s1", "user", "u3", async () => {}).catch(() => {});

      const removed = q.removeByCount("s1", "user", 2);
      expect(removed).toBe(2);
      expect(q.getDepth("s1")).toEqual({ system: 0, user: 1 });

      await expect(p1).rejects.toThrow(TurnDroppedError);
      await expect(p2).rejects.toThrow(TurnDroppedError);

      q.clear("s1");
      resolveFirst();
      await p0;
    });
  });

  describe("clear", () => {
    it("clears all queued entries", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      const pS = q.enqueue("s1", "system", "sys", async () => {});
      const pU = q.enqueue("s1", "user", "usr", async () => {});

      const removed = q.clear("s1");
      expect(removed).toBe(2);
      expect(q.getDepth("s1")).toEqual({ system: 0, user: 0 });

      await expect(pS).rejects.toThrow(TurnDroppedError);
      await expect(pU).rejects.toThrow(TurnDroppedError);

      resolveFirst();
      await p0;
    });

    it("clears only specified priority", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      q.enqueue("s1", "system", "sys", async () => {}).catch(() => {});
      q.enqueue("s1", "user", "usr", async () => {}).catch(() => {});

      const removed = q.clear("s1", "system");
      expect(removed).toBe(1);
      expect(q.getDepth("s1")).toEqual({ system: 0, user: 1 });

      q.clear("s1");
      resolveFirst();
      await p0;
    });

    it("returns 0 for unknown session", () => {
      expect(q.clear("unknown")).toBe(0);
    });
  });

  describe("error propagation", () => {
    it("rejects the enqueue promise when the execute function throws", async () => {
      await expect(
        q.enqueue("s1", "user", "bad", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    it("continues processing after a failed turn", async () => {
      let ran = false;
      await q.enqueue("s1", "user", "bad", async () => {
        throw new Error("boom");
      }).catch(() => {});

      await q.enqueue("s1", "user", "good", async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles removeById with non-existent ids", () => {
      expect(q.removeById("s1", ["nonexistent"])).toBe(0);
    });

    it("handles removeByRange with out-of-bounds range", async () => {
      let resolveFirst!: () => void;
      const gate = new Promise<void>((r) => { resolveFirst = r; });

      const p0 = q.enqueue("s1", "user", "blocker", async () => {
        await gate;
      });

      q.enqueue("s1", "system", "s1", async () => {}).catch(() => {});

      const removed = q.removeByRange("s1", "system", 5, 10);
      expect(removed).toBe(0);

      q.clear("s1");
      resolveFirst();
      await p0;
    });

    it("cleans up session map when queue drains", async () => {
      await q.enqueue("s1", "user", "msg", async () => {});
      // Internal map should be cleaned up
      expect(q.getDepth("s1")).toEqual({ system: 0, user: 0 });
    });
  });
});
