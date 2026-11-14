// ---------------------------------------------------------------------------
// ServicePlugin — interface + validation helper
// ---------------------------------------------------------------------------

import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "./plugin-system";
import type {
  DaemonConfigureCtx,
  ServiceRegisterCtx,
  DaemonShutdownCtx,
  HealthRegisterCtx,
} from "./hook-types";
import { definePluginWithRequiredHooks } from "./plugin-required-hooks";

/**
 * The minimum set of hooks a service plugin must provide.
 * Service plugins may also implement optional hooks.
 */
export interface ServicePlugin extends Plugin<ShoggothHooks> {
  readonly name: string;
  readonly version?: string;
  hooks: {
    "daemon.configure": (ctx: DaemonConfigureCtx) => DaemonConfigureCtx;
    "service.register": (ctx: ServiceRegisterCtx) => Promise<void>;
    "daemon.shutdown": (ctx: DaemonShutdownCtx) => Promise<void>;
    "health.register": (ctx: HealthRegisterCtx) => void;
  };
}

export const REQUIRED_SERVICE_PLUGIN_HOOKS = [
  "daemon.configure",
  "service.register",
  "daemon.shutdown",
  "health.register",
] as const;

/**
 * Validates and returns a typed ServicePlugin.
 * Throws if any required hook is missing.
 */
export function defineServicePlugin(plugin: ServicePlugin): ServicePlugin {
  return definePluginWithRequiredHooks("ServicePlugin", plugin, REQUIRED_SERVICE_PLUGIN_HOOKS);
}
