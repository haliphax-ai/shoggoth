import assert from "node:assert";
import { describe, it } from "vitest";
import {
  AgentTokenHashLengthError,
  hashAgentToken,
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

  it("mintAndRegister stores hash only and returns the raw token", () => {
    const store = new MemoryAgentTokenStore();
    const raw = store.mintAndRegister("sess-mint");
    assert.strictEqual(store.validate(raw, "sess-mint"), true);
    assert.strictEqual(store.validate(raw, "sess-other"), false);
    const raw2 = store.mintAndRegister("sess-mint");
    assert.notStrictEqual(raw2, raw);
    assert.strictEqual(store.validate(raw, "sess-mint"), false);
    assert.strictEqual(store.validate(raw2, "sess-mint"), true);
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
    assert.strictEqual(timingSafeEqualRawToHash(raw, new Uint8Array(32)), false);
  });

  it("hash compare throws on stored hash length mismatch", () => {
    const raw = "test-raw";
    assert.throws(
      () => timingSafeEqualRawToHash(raw, new Uint8Array(16)),
      AgentTokenHashLengthError,
    );
  });

  it("hash compare accepts stored hashes typed as Buffer", () => {
    const raw = "test-raw";
    const bufferHash = Buffer.from(hashAgentToken(raw));
    assert.strictEqual(timingSafeEqualRawToHash(raw, bufferHash), true);
  });
});
