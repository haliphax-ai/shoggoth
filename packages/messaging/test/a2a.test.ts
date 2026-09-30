import { describe, it } from "vitest";
import assert from "node:assert";
import { setRootLogger, type Logger } from "@shoggoth/shared";
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
    assert.equal(bus.deliver("sess-target", msg), true);
    assert.deepEqual(got, ["handoff payload"]);
    unsub();
    assert.equal(bus.deliver("sess-target", msg), false);
    assert.deepEqual(got, ["handoff payload"]);
  });

  it("returns false and logs a debug record when the target has no subscribers", () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      logs.push({ level, msg, fields });
    };
    const stub = {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      child: () => stub,
    } as unknown as Logger;
    setRootLogger(stub);

    const bus = createAgentToAgentBus();
    const msg = createInboundMessage({
      id: "a2a-drop",
      sessionId: "sess-source",
      createdAt: "t",
      body: "dropped payload",
    });
    assert.equal(bus.deliver("sess-nobody", msg), false);

    const drop = logs.find((l) => l.msg === "a2a.deliver.no_subscribers");
    assert.ok(drop, "should emit a debug record for the drop");
    assert.equal(drop!.level, "debug");
    assert.equal(drop!.fields!.targetSessionId, "sess-nobody");
    assert.equal(drop!.fields!.messageId, "a2a-drop");
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
