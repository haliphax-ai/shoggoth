import { describe, it, expect, beforeEach } from "vitest";
import { evaluateGateCondition, buildGateContext } from "../src/gate-eval";
import type { TaskState } from "../src/types";

describe("gate template parsing", () => {
  let tasks: Map<number, TaskState>;

  beforeEach(() => {
    tasks = new Map([
      [
        1,
        {
          taskDef: { id: 1, kind: "agent" as const, prompt: "task 1", failureBehavior: "continue" as const, failureNotification: "silent" as const },
          status: "done" as const,
          output: "success",
        },
      ],
      [
        2,
        {
          taskDef: { id: 2, kind: "agent" as const, prompt: "task 2", failureBehavior: "continue" as const, failureNotification: "silent" as const },
          status: "done" as const,
          output: "result_value",
        },
      ],
      [
        3,
        {
          taskDef: { id: 3, kind: "agent" as const, prompt: "task 3", failureBehavior: "continue" as const, failureNotification: "silent" as const },
          status: "failed" as const,
          error: "task failed",
        },
      ],
    ]);
  });

  it("resolves template reference for success field", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("{{task:1:success}}", ctx);
    expect(result).toBe(true);
  });

  it("resolves template reference for output field", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(`{{task:2:output}} == "result_value"`, ctx);
    expect(result).toBe(true);
  });

  it("resolves failed task success to false", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("{{task:3:success}}", ctx);
    expect(result).toBe(false);
  });

  it("supports dot notation alongside templates", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("task.1.success && {{task:2:success}}", ctx);
    expect(result).toBe(true);
  });

  it("handles complex conditions with templates", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(
      "({{task:1:success}} || {{task:3:success}}) && {{task:2:output}} == \"result_value\"",
      ctx
    );
    expect(result).toBe(true);
  });

  it("handles negation with templates", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("!{{task:3:success}}", ctx);
    expect(result).toBe(true);
  });

  it("handles contains with template output", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(`{{task:2:output}} contains "result"`, ctx);
    expect(result).toBe(true);
  });

  it("handles multiple template references in one condition", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(
      "{{task:1:success}} && {{task:2:success}} && !{{task:3:success}}",
      ctx
    );
    expect(result).toBe(true);
  });

  it("handles template with logical OR", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("{{task:3:success}} || {{task:1:success}}", ctx);
    expect(result).toBe(true);
  });

  it("handles template with equality comparison", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(`{{task:1:output}} == "success"`, ctx);
    expect(result).toBe(true);
  });

  it("handles template with inequality comparison", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(`{{task:1:output}} != "failure"`, ctx);
    expect(result).toBe(true);
  });

  it("handles mixed template and dot notation", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(
      "{{task:1:success}} && task.2.success && !task.3.success",
      ctx
    );
    expect(result).toBe(true);
  });

  it("handles parentheses with templates", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition(
      "({{task:1:success}} && {{task:2:success}}) || {{task:3:success}}",
      ctx
    );
    expect(result).toBe(true);
  });

  it("handles empty output with template", () => {
    const emptyTasks = new Map([
      [
        1,
        {
          taskDef: { id: 1, kind: "agent" as const, prompt: "task 1", failureBehavior: "continue" as const, failureNotification: "silent" as const },
          status: "done" as const,
          output: "",
        },
      ],
    ]);
    const ctx = buildGateContext(emptyTasks);
    const result = evaluateGateCondition(`{{task:1:output}} == ""`, ctx);
    expect(result).toBe(true);
  });

  it("throws on missing task reference in template", () => {
    const ctx = buildGateContext(tasks);
    expect(() => evaluateGateCondition("{{task:99:success}}", ctx)).toThrow(
      /references task 99 which has no result/
    );
  });

  it("handles whitespace around templates", () => {
    const ctx = buildGateContext(tasks);
    const result = evaluateGateCondition("  {{task:1:success}}  &&  {{task:2:success}}  ", ctx);
    expect(result).toBe(true);
  });
});
