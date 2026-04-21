// ---------------------------------------------------------------------------
// MessagingPlatformPlugin — interface + validation helper
// ---------------------------------------------------------------------------

import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "./plugin-system";
import type {
  PlatformRegisterCtx,
  PlatformStartCtx,
  PlatformStopCtx,
  HealthRegisterCtx,
} from "./hook-types";

/**
 * The minimum set of hooks a messaging platform plugin must provide.
 * Platform plugins may also implement optional hooks (message.*, session.*, etc.).
 */
export interface MessagingPlatformPlugin extends Plugin<ShoggothHooks> {
  readonly name: string;
  readonly version?: string;
  hooks: {
    "platform.register": (ctx: PlatformRegisterCtx) => void;
    "platform.start": (ctx: PlatformStartCtx) => Promise<void>;
    "platform.stop": (ctx: PlatformStopCtx) => Promise<void>;
    "health.register": (ctx: HealthRegisterCtx) => void;
  };
}

export const REQUIRED_MESSAGING_PLATFORM_HOOKS = [
  "platform.register",
  "platform.start",
  "platform.stop",
  "health.register",
] as const;

/**
 * Validates and returns a typed MessagingPlatformPlugin.
 * Throws if any required hook is missing.
 */
export function defineMessagingPlatformPlugin(
  plugin: MessagingPlatformPlugin,
): MessagingPlatformPlugin {
  for (const hook of REQUIRED_MESSAGING_PLATFORM_HOOKS) {
    if (typeof plugin.hooks[hook] !== "function") {
      throw new Error(
        `MessagingPlatformPlugin "${plugin.name}" is missing required hook "${hook}"`,
      );
    }
  }
  return plugin;
}
