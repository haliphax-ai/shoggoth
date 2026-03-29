import type { ShoggothConfig } from "@shoggoth/shared";
import {
  HookRegistry,
  loadAllPluginsFromConfig,
  type PluginAuditEvent,
} from "@shoggoth/skills-plugins";
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
 * Loads `shoggoth.json` plugins from config, records audit rows, runs startup hooks,
 * registers shutdown hooks + unload audit.
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

  const registry = new HookRegistry();
  const loaded = await loadAllPluginsFromConfig({
    config: options.config,
    registry,
    resolveFromFile: options.resolveFromFile,
    audit: (e) => appendAuditRow(options.db, pluginAuditToRow(e)),
  });
  await registry.run("daemon.startup");

  options.rt.shutdown.registerDrain("plugin-daemon-shutdown-hooks", async () => {
    await registry.run("daemon.shutdown");
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
