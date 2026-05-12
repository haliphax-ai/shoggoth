/**
 * Gateway Service Tests
 */

import { describe, it, expect } from "vitest";
import { Gateway, type SpaSession } from "../../../src/server/services/gateway";

describe("Gateway", () => {
  it("should be instantiable", () => {
    expect(() => new Gateway()).not.toThrow();
  });

  it("should have broadcastSpaSession method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.broadcastSpaSession).toBe("function");
  });

  it("should have broadcastSpa method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.broadcastSpa).toBe("function");
  });

  it("should have requestSnapshot method that returns a Promise", () => {
    const gateway = new Gateway();
    const session: SpaSession = { id: "test-session" };

    const result = gateway.requestSnapshot(session);
    expect(result).toBeInstanceOf(Promise);
  });

  it("should have close method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.close).toBe("function");
  });
});
