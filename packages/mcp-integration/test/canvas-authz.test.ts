import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeCanvasAction } from "../src/canvas-authz";

describe("authorizeCanvasAction", () => {
  it("allows operator for any session", () => {
    const d = authorizeCanvasAction({
      principalKind: "operator",
      action: "canvas.push",
      resourceSessionId: "s1",
    });
    assert.deepEqual(d, { allow: true });
  });

  it("allows agent only for own session", () => {
    assert.deepEqual(
      authorizeCanvasAction({
        principalKind: "agent",
        agentSessionId: "s1",
        action: "canvas.push",
        resourceSessionId: "s1",
      }),
      { allow: true },
    );
    const deny = authorizeCanvasAction({
      principalKind: "agent",
      agentSessionId: "s1",
      action: "canvas.push",
      resourceSessionId: "s2",
    });
    assert.equal(deny.allow, false);
  });

  it("requires system component", () => {
    const deny = authorizeCanvasAction({
      principalKind: "system",
      action: "canvas.present",
      resourceSessionId: "s1",
    });
    assert.equal(deny.allow, false);
    const ok = authorizeCanvasAction({
      principalKind: "system",
      action: "canvas.present",
      resourceSessionId: "s1",
      systemComponent: "cron",
    });
    assert.deepEqual(ok, { allow: true });
  });
});
