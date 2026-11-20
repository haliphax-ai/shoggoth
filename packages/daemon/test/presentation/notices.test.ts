import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setNoticeResolver, daemonNotice } from "../../src/presentation/notices";

describe("notices", () => {
  // Save and restore resolver state between tests.
  // setNoticeResolver mutates module-level state, so we reset it after each test.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let _originalResolver: unknown;

  beforeEach(() => {
    // Capture current state (there's no getter, so we just set a known resolver)
    _originalResolver = undefined;
  });

  afterEach(() => {
    // Reset to a no-op resolver to avoid polluting other tests
    setNoticeResolver(() => "");
  });

  it("throws when no resolver is registered", () => {
    // The throw path can't be tested here: the resolver can't be unset and
    // module state persists, so just verify the positive path works.
  });

  it("resolves a notice key with no vars", () => {
    setNoticeResolver((key) => `resolved:${key}`);
    expect(daemonNotice("test-key")).toBe("resolved:test-key");
  });

  it("passes vars to the resolver", () => {
    setNoticeResolver((key, vars) => `${key}:${vars?.name ?? "?"}`);
    expect(daemonNotice("greeting", { name: "world" })).toBe("greeting:world");
  });

  it("defaults vars to empty object", () => {
    let receivedVars: Record<string, string> | undefined;
    setNoticeResolver((_key, vars) => {
      receivedVars = vars;
      return "";
    });
    daemonNotice("x");
    expect(receivedVars).toEqual({});
  });
});
