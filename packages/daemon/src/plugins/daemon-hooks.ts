// -------------------------------------------------------------------------------
// daemon-hooks.ts — Orchestrates hook firing in the correct boot sequence
// -------------------------------------------------------------------------------

import type { ShoggothConfig } from "@shoggoth/shared";
import type { ShoggothPluginSystem, PlatformDeps, PlatformDeliveryRegistry } from "@shoggoth/plugins";
import type { PlatformRegistration, PlatformRuntime } from "@shoggoth/messaging";
import type { SubagentRuntimeExtension, MessageToolContext, PlatformAdapter } from "@shoggoth/shared";
import type { HealthProbe } from "@shoggoth/plugins";

export interface DaemonHooksContext {
  config: ShoggothConfig;
  db: unknown;
  configRef: { current: ShoggothConfig };
  env: NodeJS.ProcessEnv;
  platforms: Map<string, PlatformRuntime>;
  deliveryRegistry: PlatformDeliveryRegistry;
  registerDrain: (name: string, fn: () => void | Promise<void>) => void;
  registerPlatform: (reg: PlatformRegistration) => void;
  setPlatformRuntime: (platformId: string, runtime: PlatformRuntime) => void;
  registerProbe: (probe: HealthProbe) => void;
  deps: PlatformDeps;
  setSubagentRuntimeExtension: (ext: SubagentRuntimeExtension | undefined) => void;
  setMessageToolContext: (ctx: MessageToolContext) => void;
  setPlatformAdapter: (adapter: PlatformAdapter) => void;
}

export interface DaemonHooksResult {
  config: ShoggothConfig;
  drains: {
    platformStop: () => Promise<void>;
    daemonShutdown: () => Promise<void>;
  };
}

/**
 * Fires daemon lifecycle hooks in the correct boot sequence order:
 *
 * 1. daemon.configure  (sync waterfall — returns transformed config)
 * 2. platform.register (sync)
 * 3. health.register   (sync)
 * 4. platform.start    (async)
 * 5. daemon.startup    (async)
 * 6. Lock plugin system
 * 7. daemon.ready      (async)
 *
 * Returns the final config and drain functions for shutdown hooks.
 */
export async function fireDaemonHooks(
  system: ShoggothPluginSystem,
  ctx: DaemonHooksContext,
): Promise<DaemonHooksResult> {
  // 1. daemon.configure waterfall
  const configureResult = system.lifecycle["daemon.configure"].emit({
    config: ctx.config,
  });
  const config = configureResult?.config ?? ctx.config;

  // 2. platform.register (sync)
  system.lifecycle["platform.register"].emit({
    config,
    registerPlatform: ctx.registerPlatform,
    setPlatformRuntime: ctx.setPlatformRuntime,
  });

  // 3. health.register (sync)
  system.lifecycle["health.register"].emit({
    registerProbe: ctx.registerProbe,
  });

  // 4. platform.start (async)
  await system.lifecycle["platform.start"].emit({
    db: ctx.db,
    config,
    configRef: ctx.configRef,
    env: ctx.env,
    deps: ctx.deps,
    deliveryRegistry: ctx.deliveryRegistry,
    registerDrain: ctx.registerDrain,
    setSubagentRuntimeExtension: ctx.setSubagentRuntimeExtension,
    setMessageToolContext: ctx.setMessageToolContext,
    setPlatformAdapter: ctx.setPlatformAdapter,
  });

  // 5. daemon.startup (async)
  await system.lifecycle["daemon.startup"].emit({
    db: ctx.db,
    config,
    configRef: ctx.configRef,
    registerDrain: ctx.registerDrain,
  });

  // 6. Lock plugin system
  system.lock();

  // 7. daemon.ready (async)
  await system.lifecycle["daemon.ready"].emit({
    config,
    platforms: ctx.platforms,
  });

  // Return config + drain functions for shutdown
  return {
    config,
    drains: {
      platformStop: async () => {
        await system.lifecycle["platform.stop"].emit({ platformId: "*" });
      },
      daemonShutdown: async () => {
        await system.lifecycle["daemon.shutdown"].emit({ reason: "shutdown" });
      },
    },
  };
}
