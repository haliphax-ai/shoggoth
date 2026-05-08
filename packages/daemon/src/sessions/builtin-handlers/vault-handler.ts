// -------------------------------------------------------------------------------
// builtin-vault — secure credential storage
// -------------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import { createSecretFifo } from "../../vault/fifo-proxy";
import type { VaultService } from "../../vault/vault-service";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("builtin-vault", vaultHandler);
}

async function vaultHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const vault = ctx.vault;
  if (!vault) {
    return { resultJson: JSON.stringify({ error: "vault service not available" }) };
  }

  // Resolve agentId from session
  const resolvedAgentId = parseAgentSessionUrn(ctx.sessionId)?.agentId;
  if (!resolvedAgentId) {
    return {
      resultJson: JSON.stringify({ error: "unable to resolve agent ID from session" }),
    };
  }

  const action = String(args.action ?? "");
  switch (action) {
    case "get":
      return vaultGet(args, vault, resolvedAgentId);
    case "set":
      return vaultSet(args, vault, resolvedAgentId);
    case "delete":
      return vaultDelete(args, vault, resolvedAgentId);
    case "list":
      return vaultList(args, vault, resolvedAgentId);
    case "inject":
      return vaultInject(args, vault, resolvedAgentId, ctx);
    default:
      return {
        resultJson: JSON.stringify({ error: `unknown action: ${action}` }),
      };
  }
}

async function vaultGet(
  args: Record<string, unknown>,
  vault: VaultService,
  agentId: string,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  // Try agent scope first via resolve
  let value = await vault.resolve(agentId, name);
  let scope = `agent:${agentId}`;

  // Fall back to global scope if not found in agent scope
  if (value === null) {
    value = await vault.get("global", name);
    scope = "global";
  }

  if (value === null) {
    return {
      resultJson: JSON.stringify({ ok: true, name, value: null, exists: false }),
    };
  }

  return {
    resultJson: JSON.stringify({ ok: true, name, value, scope }),
  };
}

async function vaultSet(
  args: Record<string, unknown>,
  vault: VaultService,
  agentId: string,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  const value = args.value;
  if (value === undefined || value === null) {
    return { resultJson: JSON.stringify({ error: "value is required" }) };
  }

  const valueStr = String(value);
  const scope = `agent:${agentId}`;

  await vault.put(scope, name, valueStr);

  return {
    resultJson: JSON.stringify({ ok: true, name, scope, written: true }),
  };
}

async function vaultDelete(
  args: Record<string, unknown>,
  vault: VaultService,
  agentId: string,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  const scope = `agent:${agentId}`;
  const deleted = await vault.delete(scope, name);

  return {
    resultJson: JSON.stringify({ ok: true, name, scope, deleted }),
  };
}

function vaultList(
  _args: Record<string, unknown>,
  vault: VaultService,
  agentId: string,
): { resultJson: string } {
  const agentScope = `agent:${agentId}`;

  const agentEntries = vault.list(agentScope);
  const globalEntries = vault.list("global");

  const entries = [...agentEntries, ...globalEntries];

  return {
    resultJson: JSON.stringify({ ok: true, entries }),
  };
}

async function vaultInject(
  args: Record<string, unknown>,
  vault: VaultService,
  agentId: string,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  // Resolve credential using scope precedence (agent first, then global)
  let value = await vault.resolve(agentId, name);
  if (value === null) {
    value = await vault.get("global", name);
  }

  if (value === null) {
    return {
      resultJson: JSON.stringify({ ok: true, name, exists: false }),
    };
  }

  const { uid, gid } = ctx.creds;
  const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : undefined;
  const path = await createSecretFifo(value, uid, gid, timeoutMs);

  return {
    resultJson: JSON.stringify({
      ok: true,
      name,
      path,
      hint: "Use this path in your command. The file will be consumed on first read.",
    }),
  };
}
