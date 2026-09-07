/**
 * MCP Vault Environment Variable Resolution
 *
 * Scans MCP server env maps for $vault:<name> references and resolves them
 * using the connecting agent's scope precedence. Supports $vault:<name> as
 * a substring within env var values (e.g. "Bearer $vault:API_KEY").
 */

import type { VaultService } from "../vault/vault-service";

const VAULT_PREFIX = "$vault:";
const VAULT_PREFIX_LEN = VAULT_PREFIX.length;

// Valid credential name pattern: all-uppercase or all-lowercase with digits, underscores, hyphens
const CREDENTIAL_NAME_PATTERN = /^([A-Z][A-Z0-9_-]*|[a-z][a-z0-9_-]*)$/;

/**
 * Regex for matching $vault:<name> as a substring within a larger string.
 *
 * The name portion must be entirely uppercase or entirely lowercase (with
 * digits, underscores, and hyphens). A negative lookahead ensures the name
 * is not followed by additional valid-name characters (e.g. $vault:API_KEYsuffix
 * does not match because "suffix" would extend the name beyond a valid
 * credential identifier).
 */
const VAULT_REF_PATTERN = /\$vault:([A-Z][A-Z0-9_-]*|[a-z][a-z0-9_-]*)(?![A-Za-z0-9_-])/g;

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
 * Resolve all $vault:<name> substrings within a value.
 *
 * Finds every valid $vault:<name> reference in the string, resolves each
 * using the vault service with the agent's scope precedence, and returns
 * the fully resolved string.
 *
 * If any referenced credential is not found, the entire env var is omitted
 * (returns null) with a warning logged.
 *
 * @param value - The env var value that may contain $vault:<name> substrings.
 * @param vault - The vault service instance.
 * @param agentId - The connecting agent's ID for scope resolution.
 * @param envKey - The env var key (for warning messages).
 * @returns The resolved string, or null if any credential was not found.
 */
async function resolveVaultSubstrings(
  value: string,
  vault: VaultService,
  agentId?: string,
  envKey?: string,
): Promise<string | null> {
  // Quick check: if no $vault: at all, return as-is without regex overhead
  if (!value.includes(VAULT_PREFIX)) {
    return value;
  }

  // Collect all vault references found in the string
  const matches: Array<{ full: string; name: string; index: number }> = [];
  // Reset lastIndex since we reuse the regex with the global flag
  VAULT_REF_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAULT_REF_PATTERN.exec(value)) !== null) {
    matches.push({ full: m[0], name: m[1], index: m.index });
  }

  // No valid vault references found (e.g. "$vault:" with no valid name after it)
  if (matches.length === 0) {
    return value;
  }

  // Resolve each unique credential name
  const resolved = new Map<string, string | null>();
  for (const match of matches) {
    if (!resolved.has(match.name)) {
      const cred = agentId
        ? await vault.resolve(agentId, match.name)
        : await vault.get("global", match.name);
      resolved.set(match.name, cred);
      if (cred === null) {
        const scope = agentId ? `agent "${agentId}"` : "global";
        console.warn(
          `[vault] Credential "${match.name}" not found for ${scope}, omitting env var "${envKey ?? "unknown"}"`,
        );
      }
    }
  }

  // If any credential was not found, omit the entire env var
  for (const match of matches) {
    if (resolved.get(match.name) === null) {
      return null;
    }
  }

  // Build the resolved string by replacing each reference (in reverse order to preserve indices)
  let result = value;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const credValue = resolved.get(match.name)!;
    result =
      result.slice(0, match.index) + credValue + result.slice(match.index + match.full.length);
  }

  return result;
}

/**
 * Resolve vault references in an MCP server's environment variables.
 *
 * Scans the env map for values containing `$vault:<name>` references (as full
 * values or inline substrings), resolves each using the vault service with the
 * agent's scope precedence (agent:<agentId> first, then global), and replaces
 * references with plaintext values.
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
  agentId?: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const resolved = await resolveVaultSubstrings(value, vault, agentId, key);
    if (resolved !== null) {
      result[key] = resolved;
    }
  }

  return result;
}
