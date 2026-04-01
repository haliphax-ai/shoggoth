import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGraph, validateGraph, getTransitiveDeps } from "../src/graph.js";

describe("parseGraph", () => {
  it("parses a simple dependency: 1>2", () => {
    const g = parseGraph("1>2");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(2), new Set([1]));
  });

  it("parses a chain: 1-3 → 1→2→3", () => {
    const g = parseGraph("1-3");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(2), new Set([1]));
    assert.deepStrictEqual(g.get(3), new Set([2]));
  });

  it("parses a longer chain: 1-5", () => {
    const g = parseGraph("1-5");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(2), new Set([1]));
    assert.deepStrictEqual(g.get(3), new Set([2]));
    assert.deepStrictEqual(g.get(4), new Set([3]));
    assert.deepStrictEqual(g.get(5), new Set([4]));
  });

  it("parses a group dependency: 1,3,4>5", () => {
    const g = parseGraph("1,3,4>5");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(3), new Set());
    assert.deepStrictEqual(g.get(4), new Set());
    assert.deepStrictEqual(g.get(5), new Set([1, 3, 4]));
  });

  it("parses multiple lanes: 1>2 3-5 6,7>8", () => {
    const g = parseGraph("1>2 3-5 6,7>8");
    // Lane 1: 1>2
    assert.deepStrictEqual(g.get(2), new Set([1]));
    // Lane 2: 3-5 chain
    assert.deepStrictEqual(g.get(3), new Set());
    assert.deepStrictEqual(g.get(4), new Set([3]));
    assert.deepStrictEqual(g.get(5), new Set([4]));
    // Lane 3: 6,7>8
    assert.deepStrictEqual(g.get(8), new Set([6, 7]));
  });

  it("parses chained dependencies: 1>2>3", () => {
    const g = parseGraph("1>2>3");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(2), new Set([1]));
    assert.deepStrictEqual(g.get(3), new Set([2]));
  });

  it("returns empty graph for empty string", () => {
    const g = parseGraph("");
    assert.equal(g.size, 0);
  });

  it("returns empty graph for whitespace-only string", () => {
    const g = parseGraph("   ");
    assert.equal(g.size, 0);
  });

  it("handles a standalone task ID", () => {
    const g = parseGraph("1");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.equal(g.size, 1);
  });

  it("handles a standalone group with no deps", () => {
    const g = parseGraph("1,2,3");
    assert.deepStrictEqual(g.get(1), new Set());
    assert.deepStrictEqual(g.get(2), new Set());
    assert.deepStrictEqual(g.get(3), new Set());
  });

  it("throws on invalid task ID", () => {
    assert.throws(() => parseGraph("abc>2"), /Invalid task ID/);
  });

  it("throws on invalid chain syntax", () => {
    assert.throws(() => parseGraph("a-b"), /Invalid chain syntax/);
  });
});

describe("validateGraph", () => {
  it("passes for a valid acyclic graph", () => {
    const g = parseGraph("1>2>3");
    const warnings = validateGraph(g, new Set([1, 2, 3]));
    assert.ok(Array.isArray(warnings));
  });

  it("throws on cycle: 1>2>3>1", () => {
    // Build a cyclic graph manually
    const g = new Map<number, Set<number>>();
    g.set(1, new Set([3]));
    g.set(2, new Set([1]));
    g.set(3, new Set([2]));

    assert.throws(() => validateGraph(g, new Set([1, 2, 3])), /Cycle detected/);
  });

  it("throws on self-cycle", () => {
    const g = new Map<number, Set<number>>();
    g.set(1, new Set([1]));

    assert.throws(() => validateGraph(g, new Set([1])), /Cycle detected/);
  });

  it("throws when graph references a task not in the task list", () => {
    const g = parseGraph("1>2>3");
    assert.throws(
      () => validateGraph(g, new Set([1, 2])),
      /task 3 which is not in the task list/,
    );
  });

  it("throws when a dependency references a task not in the task list", () => {
    const g = new Map<number, Set<number>>();
    g.set(1, new Set());
    g.set(2, new Set([99]));

    assert.throws(
      () => validateGraph(g, new Set([1, 2])),
      /task 99 which is not in the task list/,
    );
  });

  it("passes for an empty graph", () => {
    const g = parseGraph("");
    const warnings = validateGraph(g, new Set());
    assert.deepStrictEqual(warnings, []);
  });
});

describe("getTransitiveDeps", () => {
  it("returns direct deps for a shallow graph", () => {
    const g = parseGraph("1>2");
    const deps = getTransitiveDeps(g, 2);
    assert.deepStrictEqual(deps, new Set([1]));
  });

  it("returns all transitive deps for a chain", () => {
    const g = parseGraph("1-4");
    const deps = getTransitiveDeps(g, 4);
    assert.deepStrictEqual(deps, new Set([1, 2, 3]));
  });

  it("returns empty set for a root task", () => {
    const g = parseGraph("1>2");
    const deps = getTransitiveDeps(g, 1);
    assert.deepStrictEqual(deps, new Set());
  });

  it("returns empty set for unknown task", () => {
    const g = parseGraph("1>2");
    const deps = getTransitiveDeps(g, 99);
    assert.deepStrictEqual(deps, new Set());
  });

  it("handles diamond dependencies", () => {
    // 1>3, 2>3, 1>2 → task 3 transitively depends on 1 and 2
    const g = parseGraph("1>2 1>3 2>3");
    const deps = getTransitiveDeps(g, 3);
    assert.ok(deps.has(1));
    assert.ok(deps.has(2));
  });
});
