// -------------------------------------------------------------------------------
// daemon-hooks.ts — Orchestrates hook firing in the correct boot sequence

// -------------------------------------------------------------------------------

import type { ShoggothPluginSystem, PlatformDeps } from "@shoggoth/plugins";

export interface DaemonHooksContext {
  config: Record<string, any>;
  db: any;
  configRef: { current: any };
  env: NodeJS.ProcessEnv;
  platforms: Map<string, any>;
  registerDrain: (name: string, fn: () => void | Promise<void>) => void;
  registerPlatform: (reg: any) => void;
  setPlatformRuntime: (platformId: string, runtime: any) => void;
  registerProbe: (probe: any) => void;
  deps: PlatformDeps;
  setSubagentRuntimeExtension: (ext: any) => void;
  setMessageToolContext: (ctx: any) => void;
  setPlatformAdapter: (adapter: any) => void;
  /** Pre-built message tool context from the daemon */
  messageToolContext?: any;
}

export interface DaemonHooksResult {
  config: Record<string, any>;
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
    registerDrain: ctx.registerDrain,
    setSubagentRuntimeExtension: ctx.setSubagentRuntimeExtension,
    setMessageToolContext: ctx.setMessageToolContext,
    setPlatformAdapter: ctx.setPlatformAdapter,
    messageToolContext: ctx.messageToolContext,
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