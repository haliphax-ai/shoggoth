import { describe, it, expect, vi } from "vitest";
import { createIdentityHandler } from "../src/identity-handler.js";

describe("createIdentityHandler", () => {
  const PROVISION_SECRET = "test-secret-abc123";

  it("accepts identity when valid provision secret is provided", () => {
    const onReceive = vi.fn();
    const handler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive,
    });

    const req = {
      headers: { "x-provision-secret": PROVISION_SECRET },
      body: {
        identity: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
      },
    };

    const result = (handler as any)(req);
    expect(result).toEqual({ ok: true });
  });

  it("rejects request without provision secret", () => {
    const onReceive = vi.fn();
    const handler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive,
    });

    const req = {
      headers: {},
      body: {
        identity: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
      },
    };

    expect(() => (handler as any)(req)).toThrow();
  });

  it("calls onReceive callback with the identity", () => {
    const onReceive = vi.fn();
    const handler = createIdentityHandler({
      provisionSecret: PROVISION_SECRET,
      onReceive,
    });

    const identity = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    const req = {
      headers: { "x-provision-secret": PROVISION_SECRET },
      body: { identity },
    };

    (handler as any)(req);
    expect(onReceive).toHaveBeenCalledWith(identity);
  });
});
