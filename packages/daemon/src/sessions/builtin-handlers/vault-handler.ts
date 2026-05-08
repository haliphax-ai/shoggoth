// -------------------------------------------------------------------------------
// builtin-vault — secure credential storage
// -------------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import { createSecretFifo } from "../../vault/fifo-proxy.js";

/**
 * Extended context with vault service and agentId.
 * The vault and agentId are injected by session-agent-turn.ts.
 */
interface VaultToolContext extends BuiltinToolContext {
  vault: {
    put: (scope: string, name: string, plaintext: string, metadata?: unknown) => Promise<void>;
    get: (scope: string, name: string) => Promise<string | null>;
    resolve: (agentId: string, name: string) => Promise<string | null>;
    delete: (scope: string, name: string) => Promise<boolean>;
    list: (scope: string) => Array<{
      name: string;
      scope: string;
      metadata: unknown | null;
      createdAt: string;
      updatedAt: string;
    }>;
    listScopes: () => string[];
    rotateKey: (newIdentity: unknown) => Promise<void>;
    readonly publicKey: string;
  };
  agentId: string;
  creds: { uid: number; gid: number };
}

export function register(registry: BuiltinToolRegistry): void {
  registry.register("builtin-vault", vaultHandler);
}

async function vaultHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  // Extend context with vault and agentId from the base context
  const vaultCtx = ctx as VaultToolContext;
  const vault = vaultCtx.vault;
  const agentId = vaultCtx.agentId;

  // Resolve agentId from session if not provided in context
  const resolvedAgentId = agentId || parseAgentSessionUrn(ctx.sessionId)?.agentId;
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
      return vaultInject(args, vault, resolvedAgentId, vaultCtx);
    default:
      return {
        resultJson: JSON.stringify({ error: `unknown action: ${action}` }),
      };
  }
}

async function vaultGet(
  args: Record<string, unknown>,
  vault: VaultToolContext["vault"],
  agentId: string,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  // Use resolve for scope precedence (agent scope first, then global)
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
  vault: VaultToolContext["vault"],
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
  vault: VaultToolContext["vault"],
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
  args: Record<string, unknown>,
  vault: VaultToolContext["vault"],
  agentId: string,
): { resultJson: string } {
  const agentScope = `agent:${agentId}`;

  // Get entries from agent scope and global scope
  const agentEntries = vault.list(agentScope);
  const globalEntries = vault.list("global");

  // Combine entries, agent scope first
  const entries = [...agentEntries, ...globalEntries];

  return {
    resultJson: JSON.stringify({ ok: true, entries }),
  };
}

async function vaultInject(
  args: Record<string, unknown>,
  vault: VaultToolContext["vault"],
  agentId: string,
  ctx: VaultToolContext,
): Promise<{ resultJson: string }> {
  const name = String(args.name ?? "");
  if (!name) {
    return { resultJson: JSON.stringify({ error: "name is required" }) };
  }

  // Resolve credential using scope precedence
  let value = await vault.resolve(agentId, name);
  if (value === null) {
    value = await vault.get("global", name);
  }

  if (value === null) {
    return {
      resultJson: JSON.stringify({ ok: true, name, exists: false }),
    };
  }

  const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : undefined;
  const { uid, gid } = ctx.creds;

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


