import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTemplateRefs,
  validateTemplateRefs,
  resolveTemplates,
} from "../src/templates.js";
import { parseGraph } from "../src/graph.js";
import type { TaskState, TaskDef } from "../src/types.js";

function makeTaskState(
  id: number,
  status: TaskState["status"],
  output?: string,
): TaskState {
  const taskDef: TaskDef = {
    id,
    prompt: `Task ${id}`,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
  return { taskDef, status, output };
}

describe("parseTemplateRefs", () => {
  it("parses {{task:1:output}}", () => {
    const refs = parseTemplateRefs("Use {{task:1:output}} here");
    assert.equal(refs.length, 1);
    assert.deepStrictEqual(refs[0], { kind: "output", taskId: 1 });
  });

  it("parses {{task:2:success}}", () => {
    const refs = parseTemplateRefs("Check {{task:2:success}}");
    assert.equal(refs.length, 1);
    assert.deepStrictEqual(refs[0], { kind: "success", taskId: 2 });
  });

  it("parses multiple refs in one prompt", () => {
    const refs = parseTemplateRefs(
      "Use {{task:1:output}} and check {{task:2:success}} then {{task:3:output}}",
    );
    assert.equal(refs.length, 3);
    assert.deepStrictEqual(refs[0], { kind: "output", taskId: 1 });
    assert.deepStrictEqual(refs[1], { kind: "success", taskId: 2 });
    assert.deepStrictEqual(refs[2], { kind: "output", taskId: 3 });
  });

  it("returns empty array for no refs", () => {
    const refs = parseTemplateRefs("No templates here");
    assert.equal(refs.length, 0);
  });

  it("handles refs with large task IDs", () => {
    const refs = parseTemplateRefs("{{task:999:output}}");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].taskId, 999);
  });
});

describe("validateTemplateRefs", () => {
  it("passes when ref points to a direct dependency", () => {
    const g = parseGraph("1>2");
    const refs = parseTemplateRefs("{{task:1:output}}");
    // Should not throw
    validateTemplateRefs(2, refs, g);
  });

  it("passes when ref points to a transitive dependency", () => {
    const g = parseGraph("1-3");
    const refs = parseTemplateRefs("{{task:1:output}}");
    // Task 3 transitively depends on 1 (via 2)
    validateTemplateRefs(3, refs, g);
  });

  it("throws when ref points to a non-dependency", () => {
    const g = parseGraph("1>2 3>4");
    const refs = parseTemplateRefs("{{task:3:output}}");
    assert.throws(
      () => validateTemplateRefs(2, refs, g),
      /task 3 is not a direct or transitive dependency/,
    );
  });

  it("throws when ref points to a downstream task", () => {
    const g = parseGraph("1>2>3");
    const refs = parseTemplateRefs("{{task:3:output}}");
    assert.throws(
      () => validateTemplateRefs(1, refs, g),
      /task 3 is not a direct or transitive dependency/,
    );
  });

  it("does nothing for empty refs", () => {
    const g = parseGraph("1>2");
    // Should not throw
    validateTemplateRefs(2, [], g);
  });
});

describe("resolveTemplates", () => {
  it("resolves {{task:N:output}} with task output", () => {
    const tasks = new Map<number, TaskState>();
    tasks.set(1, makeTaskState(1, "done", "hello world"));

    const result = resolveTemplates("Result: {{task:1:output}}", tasks);
    assert.equal(result, "Result: hello world");
  });

  it("resolves {{task:N:success}} to 'true' for done tasks", () => {
    const tasks = new Map<number, TaskState>();
    tasks.set(1, makeTaskState(1, "done"));

    const result = resolveTemplates("OK: {{task:1:success}}", tasks);
    assert.equal(result, "OK: true");
  });

  it("resolves {{task:N:success}} to 'false' for failed tasks", () => {
    const tasks = new Map<number, TaskState>();
    tasks.set(1, makeTaskState(1, "failed"));

    const result = resolveTemplates("OK: {{task:1:success}}", tasks);
    assert.equal(result, "OK: false");
  });

  it("resolves output to empty string when task has no output", () => {
    const tasks = new Map<number, TaskState>();
    tasks.set(1, makeTaskState(1, "done"));

    const result = resolveTemplates("Result: {{task:1:output}}", tasks);
    assert.equal(result, "Result: ");
  });

  it("leaves template intact when task is not found", () => {
    const tasks = new Map<number, TaskState>();

    const result = resolveTemplates("Result: {{task:99:output}}", tasks);
    assert.equal(result, "Result: {{task:99:output}}");
  });

  it("resolves multiple templates in one prompt", () => {
    const tasks = new Map<number, TaskState>();
    tasks.set(1, makeTaskState(1, "done", "data-from-1"));
    tasks.set(2, makeTaskState(2, "done", "data-from-2"));

    const result = resolveTemplates(
      "A: {{task:1:output}}, B: {{task:2:output}}, OK: {{task:1:success}}",
      tasks,
    );
    assert.equal(result, "A: data-from-1, B: data-from-2, OK: true");
  });

  it("returns prompt unchanged when no templates present", () => {
    const tasks = new Map<number, TaskState>();
    const result = resolveTemplates("No templates here", tasks);
    assert.equal(result, "No templates here");
  });
});
