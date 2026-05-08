/**
 * MCP Vault Environment Variable Resolution
 *
 * Scans MCP server env maps for $vault:<name> references and resolves them
 * using the connecting agent's scope precedence.
 */

import type { VaultService } from "../vault/vault-service.js";

const VAULT_PREFIX = "$vault:";
const VAULT_PREFIX_LEN = VAULT_PREFIX.length;

/**
 * Resolve vault references in an MCP server's environment variables.
 *
 * Scans the env map for values matching `$vault:<name>`, resolves each using
 * the vault service with the agent's scope precedence (agent:<agentId> first,
 * then global), and replaces references with plaintext values.
 *
 * If a credential is not found, the env var is omitted from the result (with
 * a warning logged). Non-vault env vars are left unchanged.
 *
 * @param env - The environment variable map from the MCP server config.
 * @param vault - The vault service instance.
 * @param agentId - The connecting agent's ID for scope resolution.
 * @returns A new env map with vault references replaced by plaintext values.
 */
export function resolveVaultEnv(
  env: Record<string, string>,
  vault: VaultService,
  agentId: string,
): Record<string, string> {
  throw new Error("not implemented");
}

/**
 * Check if a string value is a vault reference.
 * Only matches exact $vault:<name> pattern, not partial matches.
 */
export function isVaultReference(value: string): boolean {
  return value.startsWith(VAULT_PREFIX) && value.length > VAULT_PREFIX_LEN;
}

/**
 * Extract the credential name from a vault reference.
 * Returns the name after $vault: or null if not a valid reference.
 */
export function extractVaultName(value: string): string | null {
  if (!isVaultReference(value)) {
    return null;
  }
  return value.slice(VAULT_PREFIX_LEN);
}