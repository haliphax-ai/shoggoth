import { describe, it } from "vitest";
import assert from "node:assert";
import { SessionTurnLock } from "../src/sessions/session-turn-lock";

describe("SessionTurnLock", () => {
  it("serializes two concurrent acquires for the same session", async () => {
    const lock = new SessionTurnLock();
    const order: number[] = [];

    const release1 = await lock.acquire("s1");
    // Second acquire should not resolve until release1 is called
    const p2 = lock.acquire("s1").then((release2) => {
      order.push(2);
      release2();
    });

    order.push(1);
    release1();
    await p2;

    assert.deepStrictEqual(order, [1, 2]);
  });

  it("does not block different sessions", async () => {
    const lock = new SessionTurnLock();
    const order: string[] = [];

    const release1 = await lock.acquire("s1");
    const release2 = await lock.acquire("s2");

    // Both acquired immediately — different sessions don't block
    order.push("s1-acquired", "s2-acquired");

    release1();
    release2();

    assert.deepStrictEqual(order, ["s1-acquired", "s2-acquired"]);
  });

  it("release allows the next queued caller to proceed", async () => {
    const lock = new SessionTurnLock();
    const order: number[] = [];

    const release1 = await lock.acquire("s1");

    let resolve2!: () => void;
    const p2Done = new Promise<void>((r) => { resolve2 = r; });
    const p2 = lock.acquire("s1").then((release2) => {
      order.push(2);
      resolve2();
      return release2;
    });

    let resolve3!: () => void;
    const p3Done = new Promise<void>((r) => { resolve3 = r; });
    const p3 = lock.acquire("s1").then((release3) => {
      order.push(3);
      resolve3();
      return release3;
    });

    order.push(1);

    // Release first — second should proceed
    release1();
    await p2Done;
    assert.deepStrictEqual(order, [1, 2]);

    // Release second — third should proceed
    const release2 = await p2;
    release2();
    await p3Done;
    assert.deepStrictEqual(order, [1, 2, 3]);

    const release3 = await p3;
    release3();
  });

  it("cleans up the map when no more callers are queued", async () => {
    const lock = new SessionTurnLock();

    // Access internal maps for verification
    const chains = (lock as any).chains as Map<string, Promise<void>>;
    const pending = (lock as any).pending as Map<string, number>;

    const release1 = await lock.acquire("s1");
    assert.strictEqual(chains.has("s1"), true);
    assert.strictEqual(pending.get("s1"), 1);

    release1();
    assert.strictEqual(chains.has("s1"), false);
    assert.strictEqual(pending.has("s1"), false);
  });

  it("cleans up only after all queued callers finish", async () => {
    const lock = new SessionTurnLock();
    const chains = (lock as any).chains as Map<string, Promise<void>>;
    const pendingMap = (lock as any).pending as Map<string, number>;

    const release1 = await lock.acquire("s1");
    const p2 = lock.acquire("s1");

    assert.strictEqual(pendingMap.get("s1"), 2);

    release1();
    const release2 = await p2;

    // Still has an entry because release2 hasn't been called
    assert.strictEqual(chains.has("s1"), true);
    assert.strictEqual(pendingMap.get("s1"), 1);

    release2();
    assert.strictEqual(chains.has("s1"), false);
    assert.strictEqual(pendingMap.has("s1"), false);
  });
});
