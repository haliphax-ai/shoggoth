/**
 * MCP Vault Environment Variable Resolution
 *
 * Scans MCP server env maps for $vault:<name> references and resolves them
 * using the connecting agent's scope precedence. Supports $vault:<name> as
 * a substring within env var values (e.g. "Bearer $vault:API_KEY").
 */

import type { VaultService } from "../vault/vault-service";
import { getLogger } from "../logging";

const log = getLogger("vault-env-resolve");

const VAULT_PREFIX = "$vault:";
const VAULT_PREFIX_LEN = VAULT_PREFIX.length;

// Valid credential name pattern: all-uppercase or all-lowercase with digits, underscores, hyphens
const CREDENTIAL_NAME_PATTERN = /^([A-Z][A-Z0-9_-]*|[a-z][a-z0-9_-]*)$/;

/**
 * Regex matching `$vault:<name>` as a substring within a larger string. The name
 * is all-uppercase or all-lowercase (digits, underscores, hyphens); the negative
 * lookahead rejects names extended by further name characters (e.g. `$vault:API_KEYsuffix`).
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
 * Resolve all `$vault:<name>` substrings within a value via the agent's scope
 * precedence, leaving unresolvable literals in place (with a warning); see docs/vault.md.
 *
 * @param value - The env var value that may contain $vault:<name> substrings.
 * @param vault - The vault service instance.
 * @param agentId - The connecting agent's ID for scope resolution.
 * @param envKey - The env var key (for warning messages).
 * @returns The resolved string with vault references replaced.
 */
async function resolveVaultSubstrings(
  value: string,
  vault: VaultService,
  agentId?: string,
  envKey?: string,
): Promise<string> {
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
        const scope = agentId ? `agent:${agentId}` : "global";
        log.warn("vault credential not found, leaving unresolved", {
          credential: match.name,
          scope,
          envKey: envKey ?? "unknown",
        });
      }
    }
  }

  // Build the resolved string by replacing each reference (in reverse order to preserve indices)
  // Unresolved references (null) are left as-is ($vault:NAME literal stays in the string)
  let result = value;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const credValue = resolved.get(match.name);
    if (credValue === null) continue;
    result =
      result.slice(0, match.index) + credValue + result.slice(match.index + match.full.length);
  }

  return result;
}

/**
 * Resolve vault references in an MCP server's env map (full values or inline
 * substrings) to plaintext, leaving unresolvable references in place; see docs/vault.md.
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
    result[key] = await resolveVaultSubstrings(value, vault, agentId, key);
  }

  return result;
}
