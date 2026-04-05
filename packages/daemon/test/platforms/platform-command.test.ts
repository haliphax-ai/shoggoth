import { describe, it } from "vitest";
import assert from "node:assert";
import {
  parsePlatformCommand,
  translateCommandToControlOp,
  type PlatformCommand,
} from "../../src/platforms/platform-command";

describe("parsePlatformCommand", () => {
  it("parses /abort with a session_id option", () => {
    const cmd = parsePlatformCommand("abort", { session_id: "agent:main:discord:channel:abc" });
    assert.deepStrictEqual(cmd, {
      name: "abort",
      options: { session_id: "agent:main:discord:channel:abc" },
    });
  });

  it("parses a command with no options", () => {
    const cmd = parsePlatformCommand("abort", {});
    assert.deepStrictEqual(cmd, { name: "abort", options: {} });
  });

  it("returns null for empty command name", () => {
    const cmd = parsePlatformCommand("", {});
    assert.strictEqual(cmd, null);
  });
});

describe("translateCommandToControlOp", () => {
  it("translates abort command to session_abort control op", () => {
    const cmd: PlatformCommand = {
      name: "abort",
      options: { session_id: "agent:main:discord:channel:abc" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_abort",
      payload: { session_id: "agent:main:discord:channel:abc" },
    });
  });

  it("returns null for unknown command", () => {
    const cmd: PlatformCommand = { name: "bogus", options: {} };
    const op = translateCommandToControlOp(cmd);
    assert.strictEqual(op, null);
  });

  it("translates abort with no session_id (caller must resolve)", () => {
    const cmd: PlatformCommand = { name: "abort", options: {} };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_abort",
      payload: {},
    });
  });

  it("translates model command with session_id", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: { session_id: "agent:main:discord:channel:abc" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: { session_id: "agent:main:discord:channel:abc" },
    });
  });

  it("translates model command with agent_id", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: { agent_id: "my-agent" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: { agent_id: "my-agent" },
    });
  });

  it("translates model command with model_selection as JSON string", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: '{"providerId":"anthropic","model":"claude-3-5-sonnet"}',
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: { providerId: "anthropic", model: "claude-3-5-sonnet" },
      },
    });
  });

  it("translates model command with invalid JSON in model_selection (falls back to string)", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: "not-json",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: "not-json",
      },
    });
  });

  it("translates model command with no session_id or agent_id", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {},
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {},
    });
  });

  it("translates model command with both session_id and agent_id (session_id takes precedence)", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {
        session_id: "agent:main:discord:channel:abc",
        agent_id: "my-agent",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {
        session_id: "agent:main:discord:channel:abc",
      },
    });
  });
});
