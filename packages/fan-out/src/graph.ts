import type { DependencyGraph } from "./types.js";

/**
 * Parse the dependency graph DSL into a DependencyGraph.
 *
 * Syntax (space-separated lanes):
 *   1>2       — task 1 must complete before task 2
 *   1-3       — chain: 1→2→3
 *   1,3,4>5   — group: tasks 1,3,4 must all complete before 5
 *   1>2 3-5   — multiple lanes separated by spaces
 */
export function parseGraph(dsl: string): DependencyGraph {
  const graph: DependencyGraph = new Map();

  const ensure = (id: number) => {
    if (!graph.has(id)) graph.set(id, new Set());
  };

  const addDep = (taskId: number, depId: number) => {
    ensure(taskId);
    graph.get(taskId)!.add(depId);
  };

  const trimmed = dsl.trim();
  if (!trimmed) return graph;

  const lanes = trimmed.split(/\s+/);

  for (const lane of lanes) {
    // Check if it's a chain (contains `-` but not as part of a group>target)
    // We need to distinguish `1-3` (chain) from `1,3>5` (group)
    // Strategy: split on `>` first to get segments, then handle chains within segments

    if (lane.includes(">")) {
      // Split on `>` to get dependency segments
      const segments = lane.split(">");

      for (let i = 1; i < segments.length; i++) {
        const depSegment = segments[i - 1];
        const targetSegment = segments[i];

        // Each segment can be a group (comma-separated) or a single ID or a chain
        const depIds = parseSegment(depSegment);
        const targetIds = parseSegment(targetSegment);

        for (const tid of targetIds) {
          ensure(tid);
          for (const did of depIds) {
            ensure(did);
            addDep(tid, did);
          }
        }
      }
    } else if (lane.includes("-")) {
      // Pure chain: 1-5 means 1→2→3→4→5
      const [startStr, endStr] = lane.split("-");
      const start = Number(startStr);
      const end = Number(endStr);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid chain syntax: "${lane}"`);
      }

      const step = start <= end ? 1 : -1;
      const ids: number[] = [];
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        ids.push(n);
      }

      for (const id of ids) ensure(id);
      for (let i = 1; i < ids.length; i++) {
        addDep(ids[i], ids[i - 1]);
      }
    } else {
      // Single task ID or comma-separated group with no dependencies
      const ids = lane.split(",").map(Number);
      for (const id of ids) {
        if (isNaN(id)) throw new Error(`Invalid task ID in: "${lane}"`);
        ensure(id);
      }
    }
  }

  return graph;
}

/** Parse a segment that may be a comma-separated group or a single ID */
function parseSegment(segment: string): number[] {
  return segment.split(",").map((s) => {
    const n = Number(s);
    if (isNaN(n)) throw new Error(`Invalid task ID: "${s}"`);
    return n;
  });
}

/**
 * Validate a dependency graph against a set of known task IDs.
 * Throws on cycles or dead-end references.
 * Returns warnings for overlapping/duplicate edges (flattened automatically by Set).
 */
export function validateGraph(
  graph: DependencyGraph,
  taskIds: Set<number>,
): string[] {
  const warnings: string[] = [];

  // Check for references to tasks not in the task list
  for (const [taskId, deps] of graph) {
    if (!taskIds.has(taskId)) {
      throw new Error(
        `Graph references task ${taskId} which is not in the task list`,
      );
    }
    for (const dep of deps) {
      if (!taskIds.has(dep)) {
        throw new Error(
          `Task ${taskId} depends on task ${dep} which is not in the task list`,
        );
      }
    }
  }

  // Cycle detection via DFS
  detectCycles(graph);

  return warnings;
}

/** Detect cycles using iterative DFS with coloring. Throws on cycle. */
function detectCycles(graph: DependencyGraph): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();

  for (const id of graph.keys()) color.set(id, WHITE);

  for (const startId of graph.keys()) {
    if (color.get(startId) !== WHITE) continue;

    // Iterative DFS using explicit stack
    const stack: Array<{ id: number; iter: Iterator<number> }> = [];
    color.set(startId, GRAY);
    stack.push({ id: startId, iter: (graph.get(startId) ?? new Set()).values() });

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.iter.next();

      if (next.done) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }

      const neighborId = next.value;
      const neighborColor = color.get(neighborId) ?? WHITE;

      if (neighborColor === GRAY) {
        // Build cycle path for error message
        const cyclePath = stack.map((s) => s.id);
        const cycleStart = cyclePath.indexOf(neighborId);
        const cycle = cyclePath.slice(cycleStart);
        cycle.push(neighborId);
        throw new Error(`Cycle detected: ${cycle.join(" → ")}`);
      }

      if (neighborColor === WHITE) {
        color.set(neighborId, GRAY);
        stack.push({
          id: neighborId,
          iter: (graph.get(neighborId) ?? new Set()).values(),
        });
      }
    }
  }
}

/**
 * Get all transitive dependencies for a given task ID.
 */
export function getTransitiveDeps(
  graph: DependencyGraph,
  taskId: number,
): Set<number> {
  const visited = new Set<number>();
  const stack = [...(graph.get(taskId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of graph.get(current) ?? []) {
      stack.push(dep);
    }
  }

  return visited;
}
