import type { VaultService } from "./vault-service";

/**
 * Module-level ref for the vault service instance.
 * Set during daemon boot after migrations run.
 * Consumed by builtin-vault handler via BuiltinToolContext.
 */
export const vaultServiceRef: { current: VaultService | undefined } = {
  current: undefined,
};
