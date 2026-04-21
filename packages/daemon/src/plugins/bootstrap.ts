import type { ShoggothConfig } from "@shoggoth/shared";
import {
  ShoggothPluginSystem,
  loadAllPluginsFromConfig,
  type PluginAuditEvent,
} from "@shoggoth/plugins";
import type Database from "better-sqlite3";
import { appendAuditRow, type AppendAuditRowInput } from "../audit/append-audit";
import type { DaemonRuntime } from "../runtime";

/** Redaction-friendly snapshot of skills/plugins-related config for audit. */
function effectiveConfigAuditPayload(config: ShoggothConfig): string {
  return JSON.stringify({
    logLevel: config.logLevel,
    plugins: config.plugins.map((p) => ({
      id: p.id ?? null,
      kind: p.path !== undefined ? "path" : "package",
      ref: p.path ?? p.package ?? null,
    })),
    skills: {
      scanRootCount: config.skills.scanRoots.length,
      disabledIdsCount: config.skills.disabledIds.length,
    },
  });
}

function pluginAuditToRow(e: PluginAuditEvent): AppendAuditRowInput {
  return {
    source: "system",
    principalKind: "system",
    principalId: "plugin-loader",
    action: e.action,
    resource: e.resource,
    outcome: e.outcome,
    argsRedactedJson: e.detail ? JSON.stringify({ detail: e.detail }) : undefined,
  };
}

/**
 * Loads plugins from config using the new ShoggothPluginSystem,
 * records audit rows, fires daemon.startup, registers shutdown hooks.
 */
export async function bootstrapPlugins(options: {
  readonly config: ShoggothConfig;
  readonly db: Database.Database;
  readonly rt: DaemonRuntime;
  readonly resolveFromFile: string;
}): Promise<void> {
  appendAuditRow(options.db, {
    source: "system",
    principalKind: "system",
    principalId: "config-loader",
    action: "config.effective_loaded",
    resource: options.config.configDirectory,
    outcome: "success",
    argsRedactedJson: effectiveConfigAuditPayload(options.config),
  });

  const system = new ShoggothPluginSystem();
  const loaded = await loadAllPluginsFromConfig({
    config: options.config,
    system,
    resolveFromFile: options.resolveFromFile,
    audit: (e) => appendAuditRow(options.db, pluginAuditToRow(e)),
  });

  await system.lifecycle["daemon.startup"].emit({
    db: options.db,
    config: options.config,
    configRef: { current: options.config },
    registerDrain: (name: string, fn: () => void | Promise<void>) => {
      options.rt.shutdown.registerDrain(name, fn);
    },
  });

  options.rt.shutdown.registerDrain("plugin-daemon-shutdown-hooks", async () => {
    await system.lifecycle["daemon.shutdown"].emit({ reason: "shutdown" });
  });
  options.rt.shutdown.registerDrain("plugin-unload-audit", async () => {
    for (const p of loaded) {
      appendAuditRow(options.db, {
        source: "system",
        principalKind: "system",
        principalId: "plugin-loader",
        action: "plugin.unload",
        resource: p.resource,
        outcome: "success",
        argsRedactedJson: JSON.stringify({ manifestName: p.manifestName }),
      });
    }
  });
}
