/**
 * Command Handler Tests
 */

import { describe, it, expect } from "vitest";
import { registerCanvasCommands } from "../../../src/server/commands/canvas";
import { Gateway } from "../../../src/server/services/gateway";
import { SessionManager } from "../../../src/server/services/session-manager";

describe("canvas command handlers", () => {
  function setup() {
    const gateway = new Gateway();
    const sessionManager = new SessionManager();
    registerCanvasCommands(gateway, sessionManager);
    return { gateway, sessionManager };
  }

  describe("canvas.show", () => {
    it("presents to the requested session when it is valid", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.show", { session: "main" });
      expect(result).toEqual({ ok: true, session: "main" });
    });

    it("rejects an invalid session instead of defaulting to the active one", async () => {
      const { gateway, sessionManager } = setup();
      sessionManager.setActive("main");
      const result = await gateway.dispatch("canvas.show", { session: "a/b" });
      expect(result).toEqual({ error: "Invalid session" });
      expect(sessionManager.getActive()).toBe("main");
    });

    it("rejects oversized session identifiers", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.show", { session: "s".repeat(513) });
      expect(result).toEqual({ error: "Invalid session" });
    });

    it("rejects a non-string session", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.show", { session: 42 });
      expect("error" in (result as { error?: unknown })).toBe(true);
    });
  });

  describe("canvas.navigate", () => {
    it("navigates with a plain relative path", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", {
        session: "main",
        path: "docs/page",
      });
      expect(result).toEqual({ ok: true, session: "main", path: "docs/page" });
    });

    // Leading-slash paths are relative to the SPA root, so a leading slash is
    // stripped, not rejected.
    it("strips a leading slash from the path", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", {
        session: "main",
        path: "/docs/page",
      });
      expect(result).toEqual({ ok: true, session: "main", path: "docs/page" });
    });

    // Windows-style path separators are not SPA route segments.
    it("normalizes backslashes to forward slashes", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", { session: "main", path: "a\\b" });
      expect(result).toEqual({ ok: true, session: "main", path: "a/b" });
    });

    // Parent-directory segments are rejected anywhere in the path, not just at
    // the start.
    it("rejects parent-directory segments", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", {
        session: "main",
        path: "docs/../../secret",
      });
      expect(result).toEqual({ error: "Invalid path" });
    });

    it("rejects NUL bytes and oversized paths", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", { session: "main", path: "a\0b" });
      expect(result).toEqual({ error: "Invalid path" });
      const oversized = await gateway.dispatch("canvas.navigate", {
        session: "main",
        path: "x".repeat(513),
      });
      expect(oversized).toEqual({ error: "Invalid path" });
    });

    it("rejects a non-string path", async () => {
      const { gateway } = setup();
      const result = await gateway.dispatch("canvas.navigate", { session: "main", path: {} });
      expect(result).toEqual({ error: "Invalid path" });
    });
  });
});
