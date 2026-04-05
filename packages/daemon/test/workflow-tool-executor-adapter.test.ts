import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createWorkflowToolExecutorAdapter } from "../src/workflow-adapters.js";
import type { SessionMcpToolContext } from "../src/sessions/session-mcp-tool-context.js";

// ---------------------------------------------------------------------------
// Helpers: minimal fakes for dependencies
// ---------------------------------------------------------------------------

function fakeLogger() {
  const calls = {
    debug: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    warn: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    info: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
  };

  return {
    debug: (msg: string, fields?: Record<string, unknown>) => {
      calls.debug.push({ msg, fields });
    },
    warn: (msg: string, fields?: Record<string, unknown>) => {
      calls.warn.push({ msg, fields });
    },
    info: (msg: string, fields?: Record<string, unknown>) => {
      calls.info.push({ msg, fields });
    },
    calls,
  };
}

function fakeToolContext(overrides: Partial<SessionMcpToolContext> = {}): SessionMcpToolContext {
  return {
    execute: overrides.execute ?? (async () => ({ resultJson: "{}" })),
    aggregated: overrides.aggregated ?? { tools: [] },
    external: overrides.external ?? { tools: [] },
  };
}

// ---------------------------------------------------------------------------
// Tests: createWorkflowToolExecutorAdapter
// ---------------------------------------------------------------------------

describe("createWorkflowToolExecutorAdapter", () => {
  describe("interface conversion", () => {
    it("converts workflow tool call to daemon format and executes", async () => {
      const executeCalls: Array<{ name: string; argsJson: string; toolCallId: string }> = [];
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async (input) => {
          executeCalls.push(input);
          return { resultJson: JSON.stringify({ result: "success" }) };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("builtin-exec", { command: "echo hello" });

      assert.equal(result.ok, true);
      assert.equal(result.output, JSON.stringify({ result: "success" }));
      assert.equal(executeCalls.length, 1);
      const call = executeCalls[0];
      assert.equal(call.name, "builtin-exec");
      assert.deepEqual(JSON.parse(call.argsJson), { command: "echo hello" });
      assert.match(call.toolCallId, /^workflow-/);
    });

    it("generates unique toolCallIds for each execution", async () => {
      const executeCalls: Array<{ toolCallId: string }> = [];
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async (input) => {
          executeCalls.push({ toolCallId: input.toolCallId });
          return { resultJson: "{}" };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      await adapter.execute("tool-a", {});
      await adapter.execute("tool-b", {});

      assert.equal(executeCalls.length, 2);
      assert.notEqual(executeCalls[0].toolCallId, executeCalls[1].toolCallId);
    });

    it("passes complex nested arguments correctly", async () => {
      const executeCalls: Array<{ argsJson: string }> = [];
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async (input) => {
          executeCalls.push({ argsJson: input.argsJson });
          return { resultJson: "{}" };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const complexArgs = {
        nested: { deep: { value: 42 } },
        array: [1, 2, { key: "val" }],
        string: "test",
        bool: true,
        null: null,
      };

      await adapter.execute("complex-tool", complexArgs);

      assert.equal(executeCalls.length, 1);
      assert.deepEqual(JSON.parse(executeCalls[0].argsJson), complexArgs);
    });
  });

  describe("error handling", () => {
    it("returns error when tool execution throws", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          throw new Error("Tool crashed");
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("failing-tool", {});

      assert.equal(result.ok, false);
      assert.equal(result.error, "Tool crashed");
      assert.equal(result.output, "");
      assert.equal(logger.calls.warn.length, 1);
      assert.match(logger.calls.warn[0].msg, /failed/);
    });

    it("returns error when tool returns invalid JSON", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return { resultJson: "not valid json {" };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("bad-json-tool", {});

      assert.equal(result.ok, false);
      assert.match(result.error, /invalid JSON/i);
      assert.equal(result.output, "");
      assert.equal(logger.calls.warn.length, 1);
    });

    it("returns error when tool result contains error field", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return {
            resultJson: JSON.stringify({
              error: "tool_error",
              message: "Something went wrong",
            }),
          };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("error-tool", {});

      assert.equal(result.ok, false);
      assert.equal(result.error, "Something went wrong");
      assert.equal(result.output, "");
    });

    it("uses error field as message when message field is missing", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return {
            resultJson: JSON.stringify({
              error: "generic_error",
            }),
          };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("error-tool", {});

      assert.equal(result.ok, false);
      assert.equal(result.error, "generic_error");
    });
  });

  describe("unavailable context", () => {
    it("returns error when context is undefined", async () => {
      const logger = fakeLogger();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => undefined,
        logger,
      });

      const result = await adapter.execute("some-tool", {});

      assert.equal(result.ok, false);
      assert.match(result.error, /not available/i);
      assert.equal(result.output, "");
      assert.equal(logger.calls.warn.length, 1);
      assert.match(logger.calls.warn[0].msg, /no context/);
    });

    it("logs session ID and tool name when context unavailable", async () => {
      const logger = fakeLogger();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-debug-1",
        getToolContext: async () => undefined,
        logger,
      });

      await adapter.execute("debug-tool", {});

      assert.equal(logger.calls.warn.length, 1);
      const fields = logger.calls.warn[0].fields;
      assert.equal(fields?.tool, "debug-tool");
      assert.equal(fields?.sessionId, "sess-debug-1");
    });
  });

  describe("context resolution errors", () => {
    it("returns error when getToolContext throws", async () => {
      const logger = fakeLogger();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => {
          throw new Error("Context resolution failed");
        },
        logger,
      });

      const result = await adapter.execute("tool", {});

      assert.equal(result.ok, false);
      assert.equal(result.error, "Context resolution failed");
      assert.equal(result.output, "");
      assert.equal(logger.calls.warn.length, 1);
    });

    it("logs context resolution error with tool and session info", async () => {
      const logger = fakeLogger();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-error-1",
        getToolContext: async () => {
          throw new Error("MCP server unavailable");
        },
        logger,
      });

      await adapter.execute("mcp-tool", {});

      assert.equal(logger.calls.warn.length, 1);
      const fields = logger.calls.warn[0].fields;
      assert.equal(fields?.tool, "mcp-tool");
      assert.equal(fields?.sessionId, "sess-error-1");
      assert.equal(fields?.error, "MCP server unavailable");
    });
  });

  describe("logging", () => {
    it("logs debug message when execution starts", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      await adapter.execute("test-tool", { arg: "value" });

      assert.equal(logger.calls.debug.length, 2); // start and completion
      assert.match(logger.calls.debug[0].msg, /executing/);
      const fields = logger.calls.debug[0].fields;
      assert.equal(fields?.tool, "test-tool");
      assert.equal(fields?.sessionId, "sess-1");
    });

    it("logs debug message when execution completes", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext();

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      await adapter.execute("test-tool", {});

      assert.equal(logger.calls.debug.length, 2);
      assert.match(logger.calls.debug[1].msg, /completed/);
    });

    it("logs debug message when tool returns error", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return {
            resultJson: JSON.stringify({
              error: "tool_error",
              message: "Tool failed",
            }),
          };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      await adapter.execute("error-tool", {});

      // Should have debug for start, debug for tool error, no warn for tool error
      assert.equal(logger.calls.debug.length, 2);
      assert.match(logger.calls.debug[1].msg, /returned error/);
    });
  });

  describe("successful execution", () => {
    it("returns ok=true with output for successful execution", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return { resultJson: JSON.stringify({ status: "ok", data: [1, 2, 3] }) };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("list-tool", {});

      assert.equal(result.ok, true);
      assert.deepEqual(JSON.parse(result.output), { status: "ok", data: [1, 2, 3] });
      assert.equal(result.error, undefined);
    });

    it("returns empty error field on success", async () => {
      const logger = fakeLogger();
      const context = fakeToolContext({
        execute: async () => {
          return { resultJson: JSON.stringify({ result: "done" }) };
        },
      });

      const adapter = createWorkflowToolExecutorAdapter({
        sessionId: "sess-1",
        getToolContext: async () => context,
        logger,
      });

      const result = await adapter.execute("tool", {});

      assert.equal(result.ok, true);
      assert.equal(result.error, undefined);
    });
  });
});
