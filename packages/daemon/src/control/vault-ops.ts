/**
 * Control plane vault operations.
 */

import type { WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "./integration-ops";
import type { VaultService, VaultEntryMetadata } from "../vault/vault-service";
import { parseEnvFile } from "../vault/env-parser";
import { ageLoadIdentity, ageGenerateIdentity } from "../vault/age-crypto";

/**
 * Extract the vault service from the integration context.
 */
function requireVaultService(ctx: IntegrationOpsContext): VaultService {
  const vault = (ctx as { vault?: VaultService }).vault;
  if (!vault) {
    throw new Error("vault service not available");
  }
  return vault;
}

/**
 * Helper to get payload object from request.
 */
function getPayload(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new Error("payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

/**
 * Helper to require a string from payload.
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`payload.${key} must be a non-empty string`);
  }
  return v.trim();
}

/**
 * Handle vault.set control operation.
 * Stores a credential in the specified scope.
 */
export async function handleVaultSet(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const scope = requireString(payload, "scope");
  const name = requireString(payload, "name");
  const value = requireString(payload, "value");
  const metadata = payload.metadata as VaultEntryMetadata | undefined;

  await vault.put(scope, name, value, metadata);

  return { ok: true, scope, name, written: true };
}

/**
 * Handle vault.get control operation.
 * Retrieves a credential from the specified scope.
 */
export async function handleVaultGet(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const scope = requireString(payload, "scope");
  const name = requireString(payload, "name");

  const value = await vault.get(scope, name);

  return { ok: true, scope, name, value };
}

/**
 * Handle vault.delete control operation.
 * Removes a credential from the specified scope.
 */
export async function handleVaultDelete(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const scope = requireString(payload, "scope");
  const name = requireString(payload, "name");

  const deleted = await vault.delete(scope, name);

  return { ok: true, deleted };
}

/**
 * Handle vault.list control operation.
 * Returns credential entries in the specified scope (or all scopes).
 */
export async function handleVaultList(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const scope = payload.scope as string | undefined;

  let entries: Array<{
    name: string;
    scope: string;
    metadata: VaultEntryMetadata | null;
    createdAt: string;
    updatedAt: string;
  }>;

  if (scope) {
    entries = vault.list(scope);
  } else {
    // No scope provided - list all scopes
    const scopes = vault.listScopes();
    entries = [];
    for (const s of scopes) {
      const scopeEntries = vault.list(s);
      entries.push(...scopeEntries);
    }
  }

  return { ok: true, entries };
}

/**
 * Handle vault.import control operation.
 * Parses env file content and stores all entries in the specified scope.
 */
export async function handleVaultImport(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const scope = requireString(payload, "scope");
  const envFileContent = requireString(payload, "envFileContent");

  const entries = parseEnvFile(envFileContent);

  // Filter out entries with empty values (they can't be encrypted)
  const nonEmptyEntries = entries.filter((entry) => entry.value !== "");

  for (const entry of nonEmptyEntries) {
    await vault.put(scope, entry.key, entry.value);
  }

  return { ok: true, imported: nonEmptyEntries.length };
}

/**
 * Handle vault.rotate-key control operation.
 * Re-encrypts all entries with a new identity.
 * If newIdentityPath is provided, loads the identity from that file.
 * Otherwise, generates a fresh identity automatically.
 */
export async function handleVaultRotateKey(
  req: WireRequest,
  _principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const vault = requireVaultService(ctx);
  const payload = getPayload(req);

  const newIdentityPath =
    typeof payload === "object" && payload !== null && "newIdentityPath" in payload
      ? String((payload as Record<string, unknown>).newIdentityPath).trim()
      : "";

  let newIdentity: import("../vault/age-crypto").AgeIdentity;
  if (newIdentityPath) {
    newIdentity = await ageLoadIdentity(newIdentityPath);
  } else {
    newIdentity = await ageGenerateIdentity();
  }

  await vault.rotateKey(newIdentity);

  return { ok: true, publicKey: newIdentity.recipient };
}
