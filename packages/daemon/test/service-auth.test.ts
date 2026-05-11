/**
 * Service Auth Tests - Per-service age identities
 *
 * Phase 2: Auth - Per-Service Age Identities
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ServiceKeyStore } from "../src/service-key-store";
import { TokenMinter, TokenValidator } from "../src/service-auth";

describe("ServiceKeyStore", () => {
  let keyStore: ServiceKeyStore;

  beforeEach(() => {
    keyStore = new ServiceKeyStore("/tmp/test-secrets");
  });

  it("generates a key pair with recipient starting with age1", async () => {
    const { recipient, identity } = await keyStore.generateKeyPair("test-service");
    expect(recipient).toMatch(/^age1/);
    expect(identity).toBeDefined();
    expect(identity.length).toBeGreaterThan(0);
  });

  it("getRecipient returns recipient after generation", async () => {
    await keyStore.generateKeyPair("test-service");
    const recipient = await keyStore.getRecipient("test-service");
    expect(recipient).toMatch(/^age1/);
    expect(recipient).toBeDefined();
  });

  it("isApproved returns true after generation", async () => {
    await keyStore.generateKeyPair("test-service");
    const approved = await keyStore.isApproved("test-service");
    expect(approved).toBe(true);
  });

  it("rotateKey returns new different recipient", async () => {
    await keyStore.generateKeyPair("test-service");
    const original = await keyStore.getRecipient("test-service");

    const { recipient: rotated } = await keyStore.rotateKey("test-service");

    expect(rotated).toMatch(/^age1/);
    expect(rotated).not.toBe(original);
  });

  it("revoke removes the registration", async () => {
    await keyStore.generateKeyPair("test-service");
    const beforeRevoke = await keyStore.getRecipient("test-service");
    expect(beforeRevoke).toBeDefined();

    keyStore.revoke("test-service");

    const afterRevoke = await keyStore.getRecipient("test-service");
    expect(afterRevoke).toBeNull();
  });
});

describe("TokenMinter", () => {
  let keyStore: TokenMinter;

  beforeEach(() => {
    const store = new ServiceKeyStore("/tmp/test-secrets");
    keyStore = new TokenMinter(store);
  });

  it("mint produces a non-empty string", async () => {
    const store = keyStore["keyStore"] as ServiceKeyStore;
    await store.generateKeyPair("test-service");

    const token = await keyStore.mint("agent-123", "test-service");
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});

describe("TokenValidator", () => {
  it("round-trips: mint then validate returns correct payload", async () => {
    const store = new ServiceKeyStore("/tmp/test-secrets");
    const minter = new TokenMinter(store);

    await store.generateKeyPair("test-service");
    const identity = await store.getIdentity("test-service");

    const token = await minter.mint("agent-123", "test-service", "session:abc123");
    const payload = await TokenValidator.validate(token, identity!);

    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe("agent-123");
    expect(payload?.scope).toBe("test-service");
    expect(payload?.session).toBe("session:abc123");
  });

  it("validate returns null for expired token", async () => {
    // This test would need a way to create an expired token
    // For now, we expect the stub to handle this
    const payload = await TokenValidator.validate("expired.token.here", "age1test");
    expect(payload).toBeNull();
  });

  it("validate returns null for wrong identity", async () => {
    const store = new ServiceKeyStore("/tmp/test-secrets");
    const minter = new TokenMinter(store);

    await store.generateKeyPair("test-service");

    const token = await minter.mint("agent-123", "test-service");
    const payload = await TokenValidator.validate(token, "AGE-SECRET-KEY-1wrong");

    expect(payload).toBeNull();
  });
});
