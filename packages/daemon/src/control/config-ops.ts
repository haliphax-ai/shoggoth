/**
 * Control plane config operations (config show and dynamic config request).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { deepMerge, loadLayeredConfigAsync, redactDeep } from "@shoggoth/shared";
import { shoggothConfigFragmentSchema, shoggothConfigSchema } from "@shoggoth/shared";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

/**
 * Handle config_show control operation.
 */
export async function handleConfigShow(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator" && principal.kind !== "agent") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "config_show requires operator or agent principal",
    );
  }
  const csPayload = payloadObject(req);
  const dynamicOnly = csPayload.dynamic === true;
  if (dynamicOnly) {
    const dynDir = ctx.config.dynamicConfigDirectory;
    if (!dynDir || !existsSync(dynDir)) {
      return { ok: true, fragments: {} };
    }
    const fragments: Record<string, unknown> = {};
    for (const name of readdirSync(dynDir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        fragments[name.slice(0, -5)] = JSON.parse(readFileSync(join(dynDir, name), "utf8"));
      } catch {
        continue;
      }
    }
    const jsonPaths = ctx.config.policy.auditRedaction.jsonPaths;
    return { ok: true, fragments: redactDeep(fragments, jsonPaths) };
  }
  const jsonPaths = ctx.config.policy.auditRedaction.jsonPaths;
  return { ok: true, config: redactDeep(ctx.config, jsonPaths) };
}

/**
 * Handle config_request control operation.
 */
export async function handleConfigRequest(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "agent") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "config_request requires agent principal");
  }
  if (!ctx.config.dynamicConfigDirectory) {
    throw new IntegrationOpError(
      "ERR_CONFIG_REQUEST_UNAVAILABLE",
      "dynamicConfigDirectory not configured",
    );
  }
  const pl = payloadObject(req);
  const crKey = typeof pl.key === "string" ? pl.key.trim() : "";
  if (!crKey || !/^[a-zA-Z0-9_-]+$/.test(crKey)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.key is required and must contain only alphanumeric characters, hyphens, and underscores",
    );
  }
  const crMode = pl.mode === "overwrite" ? "overwrite" : "merge";
  const fragmentRaw = pl.fragment;
  if (fragmentRaw === undefined || fragmentRaw === null) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.fragment is required");
  }
  // Wrap the fragment value under the key for schema validation and storage.
  const wrappedRaw = { [crKey]: fragmentRaw };
  const wrappedParse = shoggothConfigFragmentSchema.safeParse(wrappedRaw);
  if (!wrappedParse.success) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", wrappedParse.error.message);
  }
  let wrapped = wrappedParse.data;
  const dynDir = ctx.config.dynamicConfigDirectory;
  mkdirSync(dynDir, { recursive: true });
  const filePath = join(dynDir, `${crKey}.json`);
  if (crMode === "merge" && existsSync(filePath)) {
    try {
      const existing = JSON.parse(readFileSync(filePath, "utf8"));
      wrapped = deepMerge(existing, wrapped);
    } catch {
      /* overwrite if existing file is unreadable */
    }
  }
  const currentConfig = await loadLayeredConfigAsync(ctx.config.configDirectory);
  const merged = deepMerge(currentConfig, wrapped);
  const fullParse = shoggothConfigSchema.safeParse(merged);
  if (!fullParse.success) {
    return {
      ok: false,
      error: "validation_failed",
      details: fullParse.error,
    };
  }
  writeFileSync(filePath, JSON.stringify(wrapped, null, 2), {
    encoding: "utf8",
  });
  return { ok: true, path: filePath, key: crKey, mode: crMode };
}
