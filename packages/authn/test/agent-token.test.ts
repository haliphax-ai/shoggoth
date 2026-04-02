import assert from "node:assert";
import { describe, it } from "vitest";
import {
  MemoryAgentTokenStore,
  mintAgentCredentialRaw,
  timingSafeEqualRawToHash,
} from "../src/agent-token";

describe("agent token", () => {
  it("mints and validates in memory store", () => {
    const store = new MemoryAgentTokenStore();
    const raw = mintAgentCredentialRaw();
    store.register("sess-1", raw);
    assert.strictEqual(store.validate(raw, "sess-1"), true);
    assert.strictEqual(store.validate(raw, "sess-2"), false);
  });

  it("fails after revoke", () => {
    const store = new MemoryAgentTokenStore();
    const raw = mintAgentCredentialRaw();
    store.register("s", raw);
    store.revoke("s");
    assert.strictEqual(store.validate(raw, "s"), false);
  });

  it("hash compare rejects wrong stored hash", () => {
    const raw = "test-raw";
    assert.strictEqual(timingSafeEqualRawToHash(raw, Buffer.alloc(32)), false);
  });
});
