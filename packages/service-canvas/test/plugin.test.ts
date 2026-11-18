/**
 * Tests for the Canvas Service Plugin
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import createCanvasPlugin from "../src/plugin";

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

  /**
   * Register the plugin with an ephemeral server and return the plugin plus a
   * cleanup handle. The registered tools are read from registerToolsMock.
   */
  async function registerTestPlugin(registerToolsMock: ReturnType<typeof vi.fn>) {
    const registerServiceMock = vi.fn();
    const ctx = {
      registerService: registerServiceMock,
      registerTools: registerToolsMock,
      config: {
        services: {
          canvas: { port: 0, a2uiDbPath: ":memory:" },
        },
      },
    };
    const plugin = createCanvasPlugin();
    await callHook(plugin, "service.register", ctx);
    return {
      plugin,
      cleanup: () => callHook(plugin, "daemon.shutdown"),
    };
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
            canvas: { port: 0, a2uiDbPath: ":memory:" },
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
            canvas: { port: 0, a2uiDbPath: ":memory:" },
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
      expect(toolNames).toContain("canvas-present");
      expect(toolNames).toContain("canvas-hide");
      expect(toolNames).toContain("canvas-navigate");
      expect(toolNames).toContain("canvas-eval");
      expect(toolNames).toContain("canvas-snapshot");
      expect(toolNames).toContain("canvas-a2ui-push");
      expect(toolNames).toContain("canvas-navigateExternal");
      expect(toolNames).toContain("canvas-a2ui-reset");
    });

    it("starts the server on the configured port", async () => {
      const registerServiceMock = vi.fn();
      const registerToolsMock = vi.fn();
      const ctx = {
        registerService: registerServiceMock,
        registerTools: registerToolsMock,
        config: {
          services: {
            canvas: { port: 0, a2uiDbPath: ":memory:" },
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
            canvas: { port: 0, a2uiDbPath: ":memory:" },
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
            canvas: { port: 0, a2uiDbPath: ":memory:" },
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
            canvas: { port: 0, a2uiDbPath: ":memory:" },
          },
        },
      };

      const plugin = createCanvasPlugin();
      await callHook(plugin, "service.register", ctx);
      cleanups.push(() => callHook(plugin, "daemon.shutdown"));

      const tools = registerToolsMock.mock.calls[0][0];
      const presentTool = tools.find((t: { name: string }) => t.name === "canvas-present");

      const result = await presentTool.handler(
        {},
        {
          agentId: "test-agent",
          sessionUrn: "agent:test-agent:discord:channel:1480957862858719232",
        },
      );
      expect(JSON.parse(result.resultJson).ok).toBe(true);
    });

    it("canvas.hide handler returns { resultJson } with { ok: true }", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const hideTool = tools.find((t: { name: string }) => t.name === "canvas-hide");

      const result = await hideTool.handler(
        {},
        {
          agentId: "test-agent",
          sessionUrn: "agent:test-agent:discord:channel:1480957862858719232",
        },
      );
      expect(result).toEqual({
        resultJson: JSON.stringify({ ok: true }),
      });
    });

    it("canvas-a2ui-reset handler returns { resultJson } with { ok: true }", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const resetTool = tools.find((t: { name: string }) => t.name === "canvas-a2ui-reset");

      const result = await resetTool.handler(
        {},
        {
          agentId: "test-agent",
          sessionUrn: "agent:test-agent:discord:channel:1480957862858719232",
        },
      );
      expect(result).toEqual({
        resultJson: JSON.stringify({ ok: true }),
      });
    });

    it("canvas-present handler reduces a valid session URN to its agent ID", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const presentTool = tools.find((t: { name: string }) => t.name === "canvas-present");

      const urn = "agent:main:discord:channel:1480957862858719232";
      const result = await presentTool.handler(
        { session: urn },
        { agentId: "main", sessionUrn: urn },
      );
      // The gateway command receives the agent ID, not the full URN
      expect(JSON.parse(result.resultJson)).toMatchObject({ ok: true, session: "main" });
    });

    it("canvas-present handler rejects a malformed session URN with a tool error", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const presentTool = tools.find((t: { name: string }) => t.name === "canvas-present");

      const malformed = "agent:main:discord:channel";
      const result = await presentTool.handler(
        { session: malformed },
        { agentId: "main", sessionUrn: "agent:main:discord:channel:1480957862858719232" },
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.ok).toBe(false);
      // Actionable: names the offending value and the expected URN shape
      expect(parsed.error).toContain(malformed);
      expect(parsed.error).toContain("agent:<agentId>:<platform>:<resourceType>:<leaf>");
    });

    it("canvas-snapshot handler rejects a malformed session URN", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const snapshotTool = tools.find((t: { name: string }) => t.name === "canvas-snapshot");

      const result = await snapshotTool.handler(
        { session: "agent:main:discord::1480957862858719232" },
        { agentId: "main", sessionUrn: "agent:main:discord:channel:1480957862858719232" },
      );
      const parsed = JSON.parse(result.resultJson);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("session");
    });

    it("session tools fall back to ctx.sessionUrn and reduce it to the agent ID", async () => {
      const registerToolsMock = vi.fn();
      const { cleanup } = await registerTestPlugin(registerToolsMock);
      cleanups.push(cleanup);

      const tools = registerToolsMock.mock.calls[0][0];
      const sessionUrn = "agent:alpha:discord:dm:1480957862858719232";
      for (const toolName of ["canvas-present", "canvas-navigate", "canvas-a2ui-reset"]) {
        const tool = tools.find((t: { name: string }) => t.name === toolName);
        const args = toolName === "canvas-navigate" ? { path: "x/" } : {};
        const result = await tool.handler(args, { agentId: "alpha", sessionUrn });
        const parsed = JSON.parse(result.resultJson);
        // a2ui.reset replies without echoing the session; the others do
        const expected =
          toolName === "canvas-a2ui-reset" ? { ok: true } : { ok: true, session: "alpha" };
        expect(parsed).toMatchObject(expected);
      }
    });
  });
});
