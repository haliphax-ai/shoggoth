import assert from "node:assert";
import { describe, it } from "vitest";
import { createRequestIdAllocator } from "../src/json-rpc-helpers";

describe("createRequestIdAllocator", () => {
  it("allocates strictly increasing ids in normal operation", () => {
    const next = createRequestIdAllocator();
    const pending = new Set<number>();
    const isPending = (id: number): boolean => pending.has(id);
    const ids = [next(isPending), next(isPending), next(isPending)];
    assert.deepEqual(ids, [1, 2, 3]);
    // The pool must never hand out an id above the safe-integer limit.
    assert.ok(ids.every((id) => id <= Number.MAX_SAFE_INTEGER));
  });

  it("wraps to the first free id once the pool is exhausted", () => {
    let wraps = 0;
    const next = createRequestIdAllocator({ max: 3, onExhausted: () => (wraps += 1) });
    const pending = new Set<number>();
    const isPending = (id: number): boolean => pending.has(id);
    assert.deepEqual([next(isPending), next(isPending), next(isPending)], [1, 2, 3]);
    // Counter is past `max`: must wrap back to 1 (nothing pending) and fire the hook once.
    assert.equal(next(isPending), 1);
    assert.equal(wraps, 1);
    assert.equal(next(isPending), 2);
    assert.equal(wraps, 1);
  });

  it("skips ids that are still pending when wrapping", () => {
    const next = createRequestIdAllocator({ max: 3 });
    const pending = new Set<number>();
    const isPending = (id: number): boolean => pending.has(id);
    // Drain the pool [1..3] so the next allocation must wrap.
    assert.deepEqual([next(isPending), next(isPending), next(isPending)], [1, 2, 3]);
    // Requests 1 and 3 are still in flight: the wrap must skip both and land on 2.
    pending.add(1);
    pending.add(3);
    assert.equal(next(isPending), 2);
    // When the entire pool is pending, the wrap must throw rather than reuse an
    // id — covered by the exhaustion test below.
  });

  it("throws instead of reusing an id when every id in the pool is pending", () => {
    const next = createRequestIdAllocator({ max: 2 });
    const pending = new Set<number>();
    const isPending = (id: number): boolean => pending.has(id);
    assert.equal(next(isPending), 1);
    assert.equal(next(isPending), 2);
    pending.add(1);
    pending.add(2);
    assert.throws(() => next(isPending), /exhausted/);
  });
});
