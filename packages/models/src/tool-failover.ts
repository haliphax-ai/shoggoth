import { isFailoverEligibleError } from "./classify";
import type { FailoverChainEntry, FailoverHooks } from "./failover";
import type { ModelCapabilities, ModelToolCompleteInput, ModelToolCompleteOutput } from "./types";

export type FailoverToolCompleteOutput = ModelToolCompleteOutput & {
  readonly usedProviderId: string;
  readonly usedModel: string;
  readonly degraded: boolean;
  /** Thinking format from the active failover hop's provider capabilities. */
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
};

export interface FailoverToolCallingClient {
  readonly capabilities?: ModelCapabilities;
  completeWithTools(input: ModelToolCompleteInput): Promise<FailoverToolCompleteOutput>;
}

export function createFailoverToolCallingClient(
  chain: readonly FailoverChainEntry[],
  hooks?: FailoverHooks,
): FailoverToolCallingClient {
  if (chain.length === 0) {
    throw new Error("failover chain must not be empty");
  }

  return {
    async completeWithTools(input) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i]!;

        // Skip providers marked as failed
        if (hooks?.isProviderFailed?.(entry.provider.id)) {
          continue;
        }

        const model = entry.model;
        const req: ModelToolCompleteInput = {
          ...input,
          model,
        };
        try {
          const out = await entry.provider.completeWithTools(req);
          const thinkingFormat = input.thinkingFormat ?? entry.thinkingFormat ?? entry.provider.capabilities?.thinkingFormat;
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
