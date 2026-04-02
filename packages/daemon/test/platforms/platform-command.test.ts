import { describe, it } from "vitest";
import assert from "node:assert";
import {
  parsePlatformCommand,
  translateCommandToControlOp,
  type PlatformCommand,
} from "../../src/platforms/platform-command";

describe("parsePlatformCommand", () => {
  it("parses /abort with a session_id option", () => {
    const cmd = parsePlatformCommand("abort", { session_id: "agent:main:discord:abc" });
    assert.deepStrictEqual(cmd, {
      name: "abort",
      options: { session_id: "agent:main:discord:abc" },
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
      options: { session_id: "agent:main:discord:abc" },
    };
    const op = translateCommandToControlOp(cmd);
    assert.deepStrictEqual(op, {
      op: "session_abort",
      payload: { session_id: "agent:main:discord:abc" },
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
});
