// ---------------------------------------------------------------------------
// config-show & config-request handlers
// ---------------------------------------------------------------------------

import { IntegrationOpError } from "../../control/integration-ops";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("config-show", configShow);
  registry.register("config-request", configRequest);
}

async function configShow(
  _args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return { resultJson: JSON.stringify({ error: "config_show_unavailable" }) };
  }
  try {
    const result = await inv(ctx.sessionId, "config_show", {});
    return { resultJson: JSON.stringify(result) };
  } catch (e) {
    if (e instanceof IntegrationOpError) {
      return {
        resultJson: JSON.stringify({ ok: false, code: e.code, message: e.message }),
      };
    }
    throw e;
  }
}

async function configRequest(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const inv = ctx.getAgentIntegrationInvoker();
  if (!inv) {
    return { resultJson: JSON.stringify({ error: "config_request_unavailable" }) };
  }
  try {
    const result = await inv(ctx.sessionId, "config_request", { key: args.key, fragment: args.fragment, mode: args.mode });
    return { resultJson: JSON.stringify(result) };
  } catch (e) {
    if (e instanceof IntegrationOpError) {
      return {
        resultJson: JSON.stringify({ ok: false, code: e.code, message: e.message }),
      };
    }
    throw e;
  }
}
