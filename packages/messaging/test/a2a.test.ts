import { describe, it } from "vitest";
import assert from "node:assert";
import { createAgentToAgentBus } from "../src/a2a";
import { createInboundMessage } from "../src/model";

describe("Agent-to-agent delivery", () => {
  it("delivers InternalMessage copies to subscribers of target session", () => {
    const bus = createAgentToAgentBus();
    const got: string[] = [];
    const unsub = bus.subscribe("sess-target", (m) => got.push(m.body));
    const msg = createInboundMessage({
      id: "a2a-1",
      sessionId: "sess-source",
      agentId: "subagent-1",
      createdAt: "2026-03-27T21:20:00.000Z",
      body: "handoff payload",
    });
    bus.deliver("sess-target", msg);
    assert.deepEqual(got, ["handoff payload"]);
    unsub();
    bus.deliver("sess-target", msg);
    assert.deepEqual(got, ["handoff payload"]);
  });

  it("isolates sessions: only matching subscribers receive", () => {
    const bus = createAgentToAgentBus();
    const log: string[] = [];
    bus.subscribe("a", () => log.push("a"));
    bus.subscribe("b", () => log.push("b"));
    bus.deliver(
      "b",
      createInboundMessage({
        id: "x",
        sessionId: "src",
        createdAt: "t",
        body: "only-b",
      }),
    );
    assert.deepEqual(log, ["b"]);
  });
});
