import { describe, it } from "vitest";
import assert from "node:assert";
import {
  parsePlatformCommand,
  translateCommandToControlOp,
  type PlatformCommand,
} from "../../src/platforms/platform-command";

describe("parsePlatformCommand", () => {
  it("parses /abort with a session_id option", () => {
    const cmd = parsePlatformCommand("abort", {
      session_id: "agent:main:discord:channel:abc",
    });
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

  it("translates steer with prompt only (caller must resolve session)", () => {
    const cmd: PlatformCommand = {
      name: "steer",
      options: { prompt: "  Focus on the failing tests first.  " },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_steer",
      payload: { prompt: "Focus on the failing tests first." },
    });
  });

  it("translates steer with session_id and trimmed prompt", () => {
    const cmd: PlatformCommand = {
      name: "steer",
      options: {
        prompt: "Wrap up after this turn.",
        session_id: " agent:target:discord:channel:ch-7 ",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_steer",
      payload: {
        prompt: "Wrap up after this turn.",
        session_id: "agent:target:discord:channel:ch-7",
      },
    });
  });

  it("translates steer with internal delivery", () => {
    const cmd: PlatformCommand = {
      name: "steer",
      options: { prompt: "Hello?", delivery: "internal" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_steer",
      payload: { prompt: "Hello?", delivery: "internal" },
    });
  });

  it("translates steer with surface delivery (omitted, daemon default)", () => {
    const cmd: PlatformCommand = {
      name: "steer",
      options: { prompt: "Hello?", delivery: "surface" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_steer",
      payload: { prompt: "Hello?" },
    });
  });

  it("translates steer with missing prompt (no prompt key)", () => {
    const cmd: PlatformCommand = { name: "steer", options: {} };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_steer",
      payload: {},
    });
  });

  it("translates prompt with routing fields forwarded and the rest as params", () => {
    const cmd: PlatformCommand = {
      name: "prompt",
      options: {
        slug: " triage ",
        session_id: " agent:main:discord:channel:abc ",
        platform_user_id: " u-42 ",
        cardId: "F-42",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "prompt",
      payload: {
        slug: "triage",
        session_id: "agent:main:discord:channel:abc",
        platform_user_id: "u-42",
        params: { cardId: "F-42" },
      },
    });
  });

  it("omits platform_user_id from the prompt payload when not provided", () => {
    const cmd: PlatformCommand = {
      name: "prompt",
      options: { slug: "triage" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "prompt",
      payload: { slug: "triage" },
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

  it("translates model command with provider/model string", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: "anthropic/claude-3-5-sonnet",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: { model: "anthropic/claude-3-5-sonnet" },
      },
    });
  });

  it("translates model command with bare string (no slash) passes through as string", () => {
    const cmd: PlatformCommand = {
      name: "model",
      options: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: "not-a-ref",
      },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_model",
      payload: {
        session_id: "agent:main:discord:channel:abc",
        model_selection: "not-a-ref",
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
