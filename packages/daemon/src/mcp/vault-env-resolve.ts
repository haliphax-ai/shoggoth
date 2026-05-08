/**
 * MCP Vault Environment Variable Resolution
 *
 * Scans MCP server env maps for $vault:<name> references and resolves them
 * using the connecting agent's scope precedence.
 */

import type { VaultService } from "../vault/vault-service";

const VAULT_PREFIX = "$vault:";
const VAULT_PREFIX_LEN = VAULT_PREFIX.length;

// Valid credential name pattern: all-uppercase or all-lowercase with digits, underscores, hyphens
const CREDENTIAL_NAME_PATTERN = /^([A-Z][A-Z0-9_-]*|[a-z][a-z0-9_-]*)$/;

/**
 * Check if a string value is a vault reference.
 * Only matches exact $vault:<name> pattern where name is a valid credential identifier.
 */
export function isVaultReference(value: string): boolean {
  if (!value.startsWith(VAULT_PREFIX) || value.length <= VAULT_PREFIX_LEN) {
    return false;
  }
  const name = value.slice(VAULT_PREFIX_LEN);
  return CREDENTIAL_NAME_PATTERN.test(name);
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
export async function resolveVaultEnv(
  env: Record<string, string>,
  vault: VaultService,
  agentId: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (isVaultReference(value)) {
      const name = extractVaultName(value);
      if (name === null) {
        result[key] = value;
        continue;
      }

      const resolved = await vault.resolve(agentId, name);
      if (resolved !== null) {
        result[key] = resolved;
      } else {
        console.warn(
          `[vault] Credential "${name}" not found for agent "${agentId}", omitting env var "${key}"`,
        );
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
