import { describe, it, expect } from "vitest";
import * as age from "age-encryption";
import { TokenValidator } from "../src/validator.js";
import type { ServiceTokenPayload } from "../src/validator.js";

async function mintToken(payload: ServiceTokenPayload, recipient: string): Promise<string> {
  const plaintext = JSON.stringify(payload);
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(plaintext);
  return Buffer.from(ciphertext).toString("base64url");
}

describe("TokenValidator", () => {
  it("round-trip: validates a properly encrypted token", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const now = Math.floor(Date.now() / 1000);
    const payload: ServiceTokenPayload = {
      sub: "agent-1",
      scope: "service",
      iat: now,
      exp: now + 300,
    };

    const token = await mintToken(payload, recipient);
    const result = await TokenValidator.validate(token, identity);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe("agent-1");
    expect(result!.scope).toBe("service");
    expect(result!.exp).toBe(now + 300);
  });

  it("returns null for an expired token", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const past = Math.floor(Date.now() / 1000) - 600;
    const payload: ServiceTokenPayload = {
      sub: "agent-1",
      scope: "service",
      iat: past,
      exp: past + 300, // already expired
    };

    const token = await mintToken(payload, recipient);
    const result = await TokenValidator.validate(token, identity);

    expect(result).toBeNull();
  });

  it("returns null when decrypted with wrong key", async () => {
    const identity1 = await age.generateIdentity();
    const recipient1 = await age.identityToRecipient(identity1);
    const identity2 = await age.generateIdentity();

    const now = Math.floor(Date.now() / 1000);
    const payload: ServiceTokenPayload = {
      sub: "agent-1",
      scope: "service",
      iat: now,
      exp: now + 300,
    };

    const token = await mintToken(payload, recipient1);
    // Validate with wrong identity
    const result = await TokenValidator.validate(token, identity2);

    expect(result).toBeNull();
  });

  it("returns null for malformed input", async () => {
    const identity = await age.generateIdentity();

    const result = await TokenValidator.validate("not-a-valid-token!!!", identity);
    expect(result).toBeNull();
  });
});
