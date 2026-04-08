import { isFailoverEligibleError } from "./classify";
import type {
  ChatMessage,
  ModelCompleteInput,
  ModelCompleteOutput,
  ModelInvocationParams,
  ModelStreamTextDeltaCallback,
} from "./types";
import type { ModelCapabilities } from "./types";
import type { ModelProvider } from "./types";

export interface FailoverChainEntry {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
  /** Override context window from provider model definition. */
  readonly contextWindowTokens?: number;
}

export interface FailoverCompleteInput extends ModelInvocationParams {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly onTextDelta?: ModelStreamTextDeltaCallback;
}

export interface FailoverCompleteOutput extends ModelCompleteOutput {
  readonly usedProviderId: string;
  readonly usedModel: string;
  /** True when a later entry in the chain produced the response. */
  readonly degraded: boolean;
  /** Thinking format from the active failover hop's provider capabilities. */
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
}

/**
 * Dependency-injection hooks so the daemon can wire DB-backed provider failure
 * tracking into the failover loop without a direct cross-package dependency.
 */
export interface FailoverHooks {
  /** Return true if the provider should be skipped (marked failed and not stale). */
  isProviderFailed?(providerId: string): boolean;
  /** Called after retry exhaustion for a provider. */
  onProviderExhausted?(providerId: string, error?: string): void;
  /** Called on successful completion (clears any prior failure record). */
  onProviderSuccess?(providerId: string): void;
}

export interface FailoverModelClient {
  readonly capabilities?: ModelCapabilities;
  complete(input: FailoverCompleteInput): Promise<FailoverCompleteOutput>;
}

export function createFailoverModelClient(
  chain: readonly FailoverChainEntry[],
  hooks?: FailoverHooks,
): FailoverModelClient {
  if (chain.length === 0) {
    throw new Error("failover chain must not be empty");
  }

  return {
    async complete(input) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i]!;

        // Skip providers marked as failed
        if (hooks?.isProviderFailed?.(entry.provider.id)) {
          continue;
        }

        const model = entry.model;
        const thinkingFormat = input.thinkingFormat ?? entry.thinkingFormat ?? entry.provider.capabilities?.thinkingFormat;
        const req: ModelCompleteInput = {
          model,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature,
          stream: input.stream,
          onTextDelta: input.onTextDelta,
          thinking: input.thinking,
          reasoningEffort: input.reasoningEffort,
          requestExtras: input.requestExtras,
          thinkingFormat,
        };
        try {
          const out = await entry.provider.complete(req);
          hooks?.onProviderSuccess?.(entry.provider.id);
          return {
            ...out,
            usedProviderId: entry.provider.id,
            usedModel: model,
            degraded: i > 0,
            thinkingFormat,
          };
        } catch (e) {
          lastErr = e;
          const more = i < chain.length - 1;
          if (more && isFailoverEligibleError(e)) {
            hooks?.onProviderExhausted?.(entry.provider.id, e instanceof Error ? e.message : String(e));
            continue;
          }
          // Last in chain or non-eligible error — mark exhausted and throw
          if (isFailoverEligibleError(e)) {
            hooks?.onProviderExhausted?.(entry.provider.id, e instanceof Error ? e.message : String(e));
          }
          throw e;
        }
      }
      throw lastErr;
    },
  };
}
