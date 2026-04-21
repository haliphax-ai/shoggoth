import assert from "node:assert";
import { describe, test } from "vitest";

// These imports target source files that DO NOT EXIST yet — tests must fail.
import {
  ShoggothPluginSystem,
  freezeConfig,
} from "../src/plugin-system";
import { defineMessagingPlatformPlugin } from "../src/messaging-platform-plugin";
import type {
  DaemonConfigureCtx,
  DaemonStartupCtx,
  PlatformRegisterCtx,
  PlatformStartCtx,
  PlatformStopCtx,
  HealthRegisterCtx,
} from "../src/hook-types";

// ---------------------------------------------------------------------------
// 1. ShoggothPluginSystem instantiation — all 14 hooks present
// ---------------------------------------------------------------------------
describe("ShoggothPluginSystem", () => {
  const ALL_HOOK_NAMES = [
    "daemon.configure",
    "daemon.startup",
    "daemon.ready",
    "daemon.shutdown",
    "platform.register",
    "platform.start",
    "platform.stop",
    "message.inbound",
    "message.outbound",
    "message.reaction",
    "session.turn.before",
    "session.turn.after",
    "session.segment.change",
    "health.register",
  ] as const;

  test("can be instantiated and exposes all 14 hooks via lifecycle", () => {
    const system = new ShoggothPluginSystem();
    assert.ok(system, "system should be truthy");
    assert.ok(system.lifecycle, "system.lifecycle should be truthy");

    for (const name of ALL_HOOK_NAMES) {
      assert.ok(
        system.lifecycle[name],
        `hook "${name}" should exist on lifecycle`,
      );
    }
    // Exactly 14 hooks — no more, no less
    const hookKeys = Object.keys(system.lifecycle);
    assert.strictEqual(hookKeys.length, 14, "should have exactly 14 hooks");
  });

  // -------------------------------------------------------------------------
  // 2. daemon.startup async hook — register plugin, fire, verify typed ctx
  // -------------------------------------------------------------------------
  test("plugin can register and fire daemon.startup async hook with typed context", async () => {
    const system = new ShoggothPluginSystem();
    const received: DaemonStartupCtx[] = [];

    system.use({
      name: "test-startup-plugin",
      hooks: {
        "daemon.startup": async (ctx: DaemonStartupCtx) => {
          received.push(ctx);
        },
      },
    });

    const fakeCtx = {
      db: {} as any,
      config: { foo: "bar" } as any,
      configRef: { current: { foo: "bar" } as any },
      registerDrain: () => {},
    } satisfies DaemonStartupCtx;

    await system.lifecycle["daemon.startup"].emit(fakeCtx);

    assert.strictEqual(received.length, 1, "handler should have been called once");
    assert.strictEqual(received[0].config, fakeCtx.config);
  });

  // -------------------------------------------------------------------------
  // 3. daemon.configure waterfall — passes through and transforms config
  // -------------------------------------------------------------------------
  test("daemon.configure waterfall passes through and transforms config", () => {
    const system = new ShoggothPluginSystem();

    system.use({
      name: "config-transform-plugin",
      hooks: {
        "daemon.configure": (ctx: DaemonConfigureCtx) => {
          // Waterfall: return a modified context
          return {
            ...ctx,
            config: { ...ctx.config, injected: true } as any,
          };
        },
      },
    });

    const initial: DaemonConfigureCtx = {
      config: { original: true } as any,
    };

    const result = system.lifecycle["daemon.configure"].emit(initial);
    assert.ok(result, "waterfall should return a result");
    assert.strictEqual(
      (result as any).config.original,
      true,
      "original config key should be preserved",
    );
    assert.strictEqual(
      (result as any).config.injected,
      true,
      "plugin should have injected a key",
    );
  });

  // -------------------------------------------------------------------------
  // 7. SyncHook (platform.register) fires synchronously with typed args
  // -------------------------------------------------------------------------
  test("platform.register SyncHook fires synchronously with typed args", () => {
    const system = new ShoggothPluginSystem();
    const registrations: string[] = [];

    system.use({
      name: "sync-register-plugin",
      hooks: {
        "platform.register": (ctx: PlatformRegisterCtx) => {
          registrations.push("called");
          // Verify typed ctx shape
          assert.ok(typeof ctx.registerPlatform === "function");
          assert.ok(typeof ctx.setPlatformRuntime === "function");
        },
      },
    });

    system.lifecycle["platform.register"].emit({
      config: {} as any,
      registerPlatform: () => {},
      setPlatformRuntime: () => {},
    } satisfies PlatformRegisterCtx);

    // Synchronous — result available immediately, no await
    assert.strictEqual(registrations.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. freezeConfig deep-freezes an object
// ---------------------------------------------------------------------------
describe("freezeConfig", () => {
  test("deep-freezes an object so mutation throws in strict mode", () => {
    const config = {
      a: 1,
      nested: { b: 2, deep: { c: 3 } },
      arr: [1, 2, 3],
    };

    const frozen = freezeConfig(config);

    // Top-level frozen
    assert.ok(Object.isFrozen(frozen), "top-level should be frozen");
    // Nested frozen
    assert.ok(Object.isFrozen(frozen.nested), "nested object should be frozen");
    assert.ok(
      Object.isFrozen(frozen.nested.deep),
      "deeply nested object should be frozen",
    );
    assert.ok(Object.isFrozen(frozen.arr), "array should be frozen");

    // Mutation should throw in strict mode (ESM is always strict)
    assert.throws(() => {
      (frozen as any).a = 999;
    }, TypeError);

    assert.throws(() => {
      (frozen.nested as any).b = 999;
    }, TypeError);

    assert.throws(() => {
      (frozen.nested.deep as any).c = 999;
    }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// 5. defineMessagingPlatformPlugin — accepts valid plugin
// ---------------------------------------------------------------------------
describe("defineMessagingPlatformPlugin", () => {
  test("accepts a valid plugin with all 4 required hooks", () => {
    const plugin = defineMessagingPlatformPlugin({
      name: "test-platform",
      hooks: {
        "platform.register": (_ctx: PlatformRegisterCtx) => {},
        "platform.start": async (_ctx: PlatformStartCtx) => {},
        "platform.stop": async (_ctx: PlatformStopCtx) => {},
        "health.register": (_ctx: HealthRegisterCtx) => {},
      },
    });

    assert.ok(plugin, "should return the plugin object");
    assert.strictEqual(plugin.name, "test-platform");
    assert.strictEqual(typeof plugin.hooks["platform.register"], "function");
    assert.strictEqual(typeof plugin.hooks["platform.start"], "function");
    assert.strictEqual(typeof plugin.hooks["platform.stop"], "function");
    assert.strictEqual(typeof plugin.hooks["health.register"], "function");
  });

  // -------------------------------------------------------------------------
  // 6. defineMessagingPlatformPlugin — throws when required hook missing
  // -------------------------------------------------------------------------
  test("throws when a required hook is missing", () => {
    assert.throws(
      () => {
        defineMessagingPlatformPlugin({
          name: "incomplete-platform",
          hooks: {
            "platform.register": (_ctx: PlatformRegisterCtx) => {},
            "platform.start": async (_ctx: PlatformStartCtx) => {},
            // Missing: platform.stop
            // Missing: health.register
          },
        } as any);
      },
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("missing required hook"),
          `error message should mention missing hook, got: ${err.message}`,
        );
        return true;
      },
    );

    // Also test missing just one hook
    assert.throws(
      () => {
        defineMessagingPlatformPlugin({
          name: "almost-complete-platform",
          hooks: {
            "platform.register": (_ctx: PlatformRegisterCtx) => {},
            "platform.start": async (_ctx: PlatformStartCtx) => {},
            "platform.stop": async (_ctx: PlatformStopCtx) => {},
            // Missing: health.register
          },
        } as any);
      },
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("health.register"),
          `error should name the missing hook "health.register", got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
