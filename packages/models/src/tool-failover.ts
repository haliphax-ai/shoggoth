import { iterateFailoverChain, type FailoverChainEntry, type FailoverHooks } from "./failover";
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
  return {
    async completeWithTools(input) {
      return iterateFailoverChain(
        chain,
        hooks,
        input,
        async (entry, input) => {
          const req: ModelToolCompleteInput = { ...input, model: entry.model };
          return entry.provider.completeWithTools(req);
        },
        (result, entry, i, thinkingFormat) => ({
          ...result,
          usedProviderId: entry.provider.id,
          usedModel: entry.model,
          degraded: i > 0,
          thinkingFormat,
        }),
      );
    },
  };
}
