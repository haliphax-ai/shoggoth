import { describe, it, expect, afterEach, assert } from "vitest";
import * as age from "age-encryption";
import { createLogger, setRootLogger, type Logger, type LogFields } from "@shoggoth/shared";
import { TokenValidator } from "../src/validator.js";
import type { ServiceTokenPayload } from "../src/validator.js";

type RecordedLog = { level: string; msg: string; fields?: Record<string, unknown> };

/** Install a recording root logger and return its captured records. */
function recordingLogger(): RecordedLog[] {
  const logs: RecordedLog[] = [];
  const record = (level: string) => (msg: string, fields?: LogFields) => {
    logs.push({ level, msg, fields });
  };
  const logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
  } as unknown as Logger;
  setRootLogger(logger);
  return logs;
}

async function mintToken(payload: ServiceTokenPayload, recipient: string): Promise<string> {
  const plaintext = JSON.stringify(payload);
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(plaintext);
  return Buffer.from(ciphertext).toString("base64url");
}

let logs: RecordedLog[] = [];
const defaultLogger: Logger = createLogger({ component: "validator.test" });

afterEach(() => {
  setRootLogger(defaultLogger);
});

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

  it("accepts a token whose iat is a few seconds in the future within skew tolerance", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const now = Math.floor(Date.now() / 1000);
    const payload: ServiceTokenPayload = {
      sub: "agent-1",
      scope: "service",
      iat: now + 15, // inside the clock-skew tolerance
      exp: now + 300,
    };

    const token = await mintToken(payload, recipient);
    const result = await TokenValidator.validate(token, identity);

    expect(result).not.toBeNull();
    expect(result!.iat).toBe(now + 15);
  });

  it("returns null for a token whose iat is in the future beyond skew tolerance", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const now = Math.floor(Date.now() / 1000);
    const payload: ServiceTokenPayload = {
      sub: "agent-1",
      scope: "service",
      iat: now + 600, // far in the future, exp still in the future
      exp: now + 900,
    };

    const token = await mintToken(payload, recipient);
    const result = await TokenValidator.validate(token, identity);

    expect(result).toBeNull();
  });

  it("returns null for malformed input", async () => {
    const identity = await age.generateIdentity();

    const result = await TokenValidator.validate("not-a-valid-token!!!", identity);
    expect(result).toBeNull();
  });

  it("logs a debug record when decryption throws", async () => {
    const identity = await age.generateIdentity();
    logs = recordingLogger();

    const result = await TokenValidator.validate("not-a-valid-token!!!", identity);

    expect(result).toBeNull();
    const record = logs.find((l) => l.msg === "token_validate_failed");
    assert.ok(record, "should emit a debug record for the failed decryption");
    assert.equal(record.level, "debug");
    assert.match(String(record.fields?.error), /.+/);
    assert.ok(
      !logs.some((l) => l.level !== "debug"),
      "no warn/error records should be emitted for invalid tokens",
    );
  });

  it("logs a debug record for non-Error throwables and valid tokens stay silent", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const now = Math.floor(Date.now() / 1000);
    const token = await mintToken(
      { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
      recipient,
    );

    logs = recordingLogger();
    const ok = await TokenValidator.validate(token, identity);
    expect(ok).not.toBeNull();
    assert.equal(logs.length, 0);

    logs = recordingLogger();
    const bad = await TokenValidator.validate("", identity);
    expect(bad).toBeNull();
    const record = logs.find((l) => l.msg === "token_validate_failed");
    assert.ok(record, "should emit a debug record for the failed decryption");
    assert.equal(record.level, "debug");
    assert.ok(typeof record.fields?.error === "string");
  });
});
