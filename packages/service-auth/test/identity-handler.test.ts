import { describe, it, expect, vi } from "vitest";
import { createIdentityHandler } from "../src/identity-handler.js";

type IdentityRequest = Parameters<ReturnType<typeof createIdentityHandler>>[0];

interface IdentityResponse {
  ok: true;
}

interface IdentityHandler {
  (req: IdentityRequest): IdentityResponse;
}

interface ProvisionRecord {
  identity: string;
}

const IDENTITY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

function makeProvisionSpy(): {
  onReceive: (identity: string) => void;
  record: ProvisionRecord;
} {
  const record: ProvisionRecord = { identity: "" };
  return {
    onReceive: (identity: string) => {
      record.identity = identity;
    },
    record,
  };
}

function makeRequest(headers: Record<string, string>, body: { identity: string }): IdentityRequest {
  return { headers, body };
}

describe("createIdentityHandler", () => {
  const PROVISION_SECRET = "test-secret-abc123";

  it("accepts identity when valid provision secret is provided", () => {
    const provision = makeProvisionSpy();
    const handler: IdentityHandler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive: provision.onReceive,
    });

    const req = makeRequest({ "x-provision-secret": PROVISION_SECRET }, { identity: IDENTITY });

    const result: IdentityResponse = handler(req);
    expect(result).toEqual({ ok: true });
  });

  it("rejects request without provision secret", () => {
    const provision = makeProvisionSpy();
    const handler: IdentityHandler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive: provision.onReceive,
    });

    const req = makeRequest({}, { identity: IDENTITY });

    expect(() => handler(req)).toThrow();
  });

  it("rejects request with a wrong provision secret", () => {
    const provision = makeProvisionSpy();
    const handler: IdentityHandler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive: provision.onReceive,
    });

    const req = makeRequest({ "x-provision-secret": "not-the-secret" }, { identity: IDENTITY });

    expect(() => handler(req)).toThrow(/Invalid or missing provision secret/);
  });

  it("calls onReceive callback with the identity", () => {
    const provision = makeProvisionSpy();
    const handler: IdentityHandler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive: provision.onReceive,
    });

    const req = makeRequest({ "x-provision-secret": PROVISION_SECRET }, { identity: IDENTITY });

    handler(req);
    expect(provision.record.identity).toBe(IDENTITY);
  });

  it("exposes a vi.fn() mock as the onReceive callback", () => {
    const onReceive = vi.fn<(identity: string) => void>();
    const handler: IdentityHandler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive,
    });

    const req = makeRequest({ "x-provision-secret": PROVISION_SECRET }, { identity: IDENTITY });

    handler(req);
    expect(onReceive).toHaveBeenCalledWith(IDENTITY);
  });
});
