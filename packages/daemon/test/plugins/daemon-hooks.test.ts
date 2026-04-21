import { describe, test, expect, vi } from "vitest";
import { ShoggothPluginSystem } from "@shoggoth/plugins";

// Module under test — does NOT exist yet → tests must fail at import time
import { fireDaemonHooks } from "../../src/plugins/daemon-hooks";

// ---------------------------------------------------------------------------
// Helpers: a test plugin that records every hook invocation in order
// ---------------------------------------------------------------------------
function createRecorderPlugin(name: string, callLog: string[]) {
  return {
    name,
    hooks: {
      "daemon.configure": (ctx: any) => {
        callLog.push(`${name}:daemon.configure`);
        return { ...ctx, config: { ...ctx.config, [`${name}_configured`]: true } };
      },
      "platform.register": (_ctx: any) => {
        callLog.push(`${name}:platform.register`);
      },
      "health.register": (_ctx: any) => {
        callLog.push(`${name}:health.register`);
      },
      "platform.start": async (_ctx: any) => {
        callLog.push(`${name}:platform.start`);
      },
      "daemon.startup": async (_ctx: any) => {
        callLog.push(`${name}:daemon.startup`);
      },
      "daemon.ready": async (_ctx: any) => {
        callLog.push(`${name}:daemon.ready`);
      },
      "platform.stop": async (_ctx: any) => {
        callLog.push(`${name}:platform.stop`);
      },
      "daemon.shutdown": async (_ctx: any) => {
        callLog.push(`${name}:daemon.shutdown`);
      },
    },
  };
}

/** Minimal context stubs for fireDaemonHooks */
function createStubContext(overrides: Record<string, any> = {}) {
  return {
    config: { logLevel: "info", plugins: [], ...(overrides.config ?? {}) },
    db: overrides.db ?? ({} as any),
    configRef: overrides.configRef ?? { current: { logLevel: "info" } },
    env: overrides.env ?? process.env,
    platforms: overrides.platforms ?? new Map(),
    registerDrain: overrides.registerDrain ?? vi.fn(),
    registerPlatform: overrides.registerPlatform ?? vi.fn(),
    setPlatformRuntime: overrides.setPlatformRuntime ?? vi.fn(),
    registerProbe: overrides.registerProbe ?? vi.fn(),
    deps: overrides.deps ?? {
      hitlStack: {},
      policyEngine: {},
      hitlConfigRef: {},
    },
    setSubagentRuntimeExtension: overrides.setSubagentRuntimeExtension ?? vi.fn(),
    setMessageToolContext: overrides.setMessageToolContext ?? vi.fn(),
    setPlatformAdapter: overrides.setPlatformAdapter ?? vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("fireDaemonHooks", () => {
  // 1. daemon.configure waterfall returns (possibly transformed) config
  test("daemon.configure waterfall is fired and returns transformed config", async () => {
    const system = new ShoggothPluginSystem();
    const callLog: string[] = [];

    system.use({
      name: "config-plugin",
      hooks: {
        "daemon.configure": (ctx: any) => {
          callLog.push("daemon.configure");
          return { ...ctx, config: { ...ctx.config, transformed: true } };
        },
      },
    });

    const ctx = createStubContext({ config: { original: true } });
    const result = await fireDaemonHooks(system, ctx);

    expect(callLog).toContain("daemon.configure");
    expect(result.config.original).toBe(true);
    expect(result.config.transformed).toBe(true);
  });

  // 2. Hooks fire in correct order:
  //    configure → platform.register → health.register → platform.start → daemon.startup → daemon.ready
  test("hooks fire in correct boot sequence order", async () => {
    const system = new ShoggothPluginSystem();
    const callLog: string[] = [];

    system.use(createRecorderPlugin("p1", callLog));

    const ctx = createStubContext();
    await fireDaemonHooks(system, ctx);

    const expectedOrder = [
      "p1:daemon.configure",
      "p1:platform.register",
      "p1:health.register",
      "p1:platform.start",
      "p1:daemon.startup",
      "p1:daemon.ready",
    ];

    expect(callLog).toEqual(expectedOrder);
  });

  test("order is preserved across multiple plugins", async () => {
    const system = new ShoggothPluginSystem();
    const callLog: string[] = [];

    system.use(createRecorderPlugin("alpha", callLog));
    system.use(createRecorderPlugin("beta", callLog));

    const ctx = createStubContext();
    await fireDaemonHooks(system, ctx);

    // Each hook phase should fire all plugins before moving to the next phase.
    // Within a phase, plugins fire in registration order (FIFO).
    const configureIdx = callLog.indexOf("alpha:daemon.configure");
    const registerIdx = callLog.indexOf("alpha:platform.register");
    const healthIdx = callLog.indexOf("alpha:health.register");
    const startIdx = callLog.indexOf("alpha:platform.start");
    const startupIdx = callLog.indexOf("alpha:daemon.startup");
    const readyIdx = callLog.indexOf("alpha:daemon.ready");

    // All configure calls happen before any platform.register calls
    const lastConfigure = Math.max(
      callLog.indexOf("alpha:daemon.configure"),
      callLog.indexOf("beta:daemon.configure"),
    );
    const firstRegister = Math.min(
      callLog.indexOf("alpha:platform.register"),
      callLog.indexOf("beta:platform.register"),
    );
    expect(lastConfigure).toBeLessThan(firstRegister);

    // Strict phase ordering
    expect(configureIdx).toBeLessThan(registerIdx);
    expect(registerIdx).toBeLessThan(healthIdx);
    expect(healthIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(startupIdx);
    expect(startupIdx).toBeLessThan(readyIdx);
  });

  // 3. platform.stop and daemon.shutdown are returned as drain functions, not fired immediately
  test("platform.stop and daemon.shutdown are returned as drain functions, not fired during boot", async () => {
    const system = new ShoggothPluginSystem();
    const callLog: string[] = [];

    system.use(createRecorderPlugin("draintest", callLog));

    const ctx = createStubContext();
    const result = await fireDaemonHooks(system, ctx);

    // platform.stop and daemon.shutdown should NOT have been called during boot
    expect(callLog).not.toContain("draintest:platform.stop");
    expect(callLog).not.toContain("draintest:daemon.shutdown");

    // They should be returned as callable drain functions
    expect(result.drains).toBeDefined();
    expect(typeof result.drains.platformStop).toBe("function");
    expect(typeof result.drains.daemonShutdown).toBe("function");

    // Calling the drain functions should fire the hooks
    await result.drains.platformStop();
    expect(callLog).toContain("draintest:platform.stop");

    await result.drains.daemonShutdown();
    expect(callLog).toContain("draintest:daemon.shutdown");
  });

  // 4. The system is locked after daemon.ready fires
  test("plugin system is locked after daemon.ready fires", async () => {
    const system = new ShoggothPluginSystem();
    const callLog: string[] = [];

    system.use(createRecorderPlugin("locktest", callLog));

    const ctx = createStubContext();
    await fireDaemonHooks(system, ctx);

    // After fireDaemonHooks completes, the system should be locked.
    // Attempting to register a new plugin should throw.
    expect(() => {
      system.use({
        name: "late-plugin",
        hooks: {
          "daemon.startup": async () => {},
        },
      });
    }).toThrow();
  });

  test("system is not locked before daemon.ready fires", async () => {
    const system = new ShoggothPluginSystem();

    // Before calling fireDaemonHooks, registration should work fine
    expect(() => {
      system.use({
        name: "early-plugin",
        hooks: {
          "daemon.startup": async () => {},
        },
      });
    }).not.toThrow();
  });

  // Edge case: no plugins registered — should still complete without error
  test("completes successfully with no plugins registered", async () => {
    const system = new ShoggothPluginSystem();
    const ctx = createStubContext();

    const result = await fireDaemonHooks(system, ctx);

    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
    expect(typeof result.drains.platformStop).toBe("function");
    expect(typeof result.drains.daemonShutdown).toBe("function");
  });

  // daemon.configure waterfall with multiple plugins chains transformations
  test("daemon.configure waterfall chains across multiple plugins", async () => {
    const system = new ShoggothPluginSystem();

    system.use({
      name: "plugin-a",
      hooks: {
        "daemon.configure": (ctx: any) => ({
          ...ctx,
          config: { ...ctx.config, a: true },
        }),
      },
    });

    system.use({
      name: "plugin-b",
      hooks: {
        "daemon.configure": (ctx: any) => ({
          ...ctx,
          config: { ...ctx.config, b: true },
        }),
      },
    });

    const ctx = createStubContext({ config: { seed: 1 } });
    const result = await fireDaemonHooks(system, ctx);

    // Both plugins should have contributed to the final config
    expect(result.config.seed).toBe(1);
    expect(result.config.a).toBe(true);
    expect(result.config.b).toBe(true);
  });
});
