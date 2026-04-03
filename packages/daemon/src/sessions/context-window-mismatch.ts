/** In-memory tracker for context window mismatch warnings. Resets on daemon restart. */

import { getLogger } from "../logging";

const log = getLogger("context-window-mismatch");

const warnedProviders = new Set<string>();

interface ContextWindowMismatchInput {
  readonly providerId: string;
  readonly configContextWindow: number | undefined;
  readonly providerContextWindow: number | undefined;
  readonly sessionId: string;
  /** Callback to surface warning to the session's message platform binding. Omit to skip platform surfacing. */
  readonly surfaceWarning?: (message: string) => void;
  /** When true, suppress platform surfacing (stderr log still fires). */
  readonly suppressNotice?: boolean;
}

/**
 * Check for context window mismatch between config and provider response.
 * Logs to stderr always. Surfaces to platform once per provider unless suppressed.
 */
export function checkContextWindowMismatch(input: ContextWindowMismatchInput): void {
  // If either value is missing, nothing to compare
  if (input.configContextWindow == null || input.providerContextWindow == null) return;
  if (input.configContextWindow === input.providerContextWindow) return;

  const key = input.providerId;

  // Always log to stderr
  log.warn("context window mismatch", {
    providerId: input.providerId,
    sessionId: input.sessionId,
    configValue: input.configContextWindow,
    providerValue: input.providerContextWindow,
  });

  // Surface to platform once per provider (unless suppressed or already warned)
  if (!input.suppressNotice && !warnedProviders.has(key) && input.surfaceWarning) {
    warnedProviders.add(key);
    input.surfaceWarning(
      `⚠️ Context window mismatch for provider \`${input.providerId}\`: config says ${input.configContextWindow} tokens, provider reports ${input.providerContextWindow} tokens.`,
    );
  }
}
