/**
 * Tests for the Canvas Service Plugin
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import createCanvasPlugin from "../src/plugin.js";

describe("createCanvasPlugin", () => {
  // Track servers to clean up
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  // Helper to invoke a hook, bypassing strict `this` typing
  function callHook(
    plugin: ReturnType<typeof createCanvasPlugin>,
    hook: string,
    ...args: unknown[]
  ) {
    const fn = plugin.hooks[hook as keyof typeof plugin.hooks] as Function;
    return fn(...args);
  }

  it("returns a plugin object with name 'service-canvas'", () => {
    const plugin = createCanvasPlugin();
    expect(plugin.name).toBe("service-canvas");
  });

  it("plugin has service.register, health.register, and daemon.shutdown hooks", () => {
    const plugin = createCanvasPlugin();
    expect(typeof plugin.hooks["service.register"]).toBe("function");
    expect(typeof plugin.hooks["health.register"]).toBe("function");
    expect(typeof plugin.hooks["daemon.shutdown"]).toBe("function");
  });

  describe("service.register hook", () => {
    it("calls ctx.registerService() with id 'canvas', expose 'both', protocol 'http+ws'", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      expect(registerServiceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "canvas",
          expose: "both",
          protocol: "http+ws",
        }),
      );
    });

    it("calls ctx.registerTools() with 8 canvas tools", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      expect(registerToolsMock).toHaveBeenCalledTimes(1);
      const tools = registerToolsMock.mock.calls[0][0];
      expect(tools).toHaveLength(8);

      const toolNames = tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain("canvas.present");
      expect(toolNames).toContain("canvas.hide");
      expect(toolNames).toContain("canvas.navigate");
      expect(toolNames).toContain("canvas.eval");
      expect(toolNames).toContain("canvas.snapshot");
      expect(toolNames).toContain("canvas.a2ui.push");
      expect(toolNames).toContain("canvas.a2ui.pushJSONL");
      expect(toolNames).toContain("canvas.a2ui.reset");
    });

    it("starts the server on the configured port", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      expect(registerServiceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          port: expect.any(Number),
        }),
      );
    });
  });

  describe("health.register hook", () => {
    it("calls ctx.registerProbe() with name 'canvas'", () => {
      const registerProbeMock = vi.fn();
      const ctx = {
        registerProbe: registerProbeMock,
      };

      const plugin = createCanvasPlugin();
      callHook(plugin, "health.register", ctx);

      expect(registerProbeMock).toHaveBeenCalledWith({
        name: "canvas",
        check: expect.any(Function),
      });
    });

    it("probe returns 'pass' when server is listening", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      let checkFn: (() => Promise<{ status: string }>) | undefined;

      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        registerProbe: (probe: { name: string; check: () => Promise<{ status: string }> }) => {
          checkFn = probe.check;
        },
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));
      callHook(plugin, "health.register", ctx);

      const result = await checkFn!();
      expect(result.status).toBe("pass");
    });

    it("probe returns 'fail' when server is not listening", async () => {
      let checkFn: (() => Promise<{ status: string }>) | undefined;

      const ctx = {
        registerProbe: (probe: { name: string; check: () => Promise<{ status: string }> }) => {
          checkFn = probe.check;
        },
      };

      const plugin = createCanvasPlugin();
      callHook(plugin, "health.register", ctx);

      // Without registering service, server is not running
      const result = await checkFn!();
      expect(result.status).toBe("fail");
    });
  });

  describe("daemon.shutdown hook", () => {
    it("closes the server gracefully", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();

      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);

      // Should not throw when shutting down
      await expect(callHook(plugin, "daemon.shutdown")).resolves.not.toThrow();
    });
  });

  describe("tool handlers", () => {
    it("canvas.present handler returns { resultJson } with { ok: true }", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      const tools = registerToolsMock.mock.calls[0][0];
      const presentTool = tools.find((t: { name: string }) => t.name === "canvas.present");

      const result = await presentTool.handler(
        {},
        { agentId: "test-agent", sessionUrn: "test:session" },
      );
      expect(result).toEqual({
        resultJson: JSON.stringify({ ok: true }),
      });
    });

    it("canvas.hide handler returns { resultJson } with { ok: true }", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      const tools = registerToolsMock.mock.calls[0][0];
      const hideTool = tools.find((t: { name: string }) => t.name === "canvas.hide");

      const result = await hideTool.handler(
        {},
        { agentId: "test-agent", sessionUrn: "test:session" },
      );
      expect(result).toEqual({
        resultJson: JSON.stringify({ ok: true }),
      });
    });

    it("canvas.a2ui.reset handler returns { resultJson } with { ok: true }", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0 },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      const tools = registerToolsMock.mock.calls[0][0];
      const resetTool = tools.find((t: { name: string }) => t.name === "canvas.a2ui.reset");

      const result = await resetTool.handler(
        {},
        { agentId: "test-agent", sessionUrn: "test:session" },
      );
      expect(result).toEqual({
        resultJson: JSON.stringify({ ok: true }),
      });
    });
  });
});
