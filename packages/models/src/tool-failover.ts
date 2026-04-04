import { isFailoverEligibleError } from "./classify";
import type { FailoverChainEntry } from "./failover";
import type { ModelToolCompleteInput, ModelToolCompleteOutput } from "./types";

export type FailoverToolCompleteOutput = ModelToolCompleteOutput & {
  readonly usedProviderId: string;
  readonly usedModel: string;
  readonly degraded: boolean;
};

export interface FailoverToolCallingClient {
  completeWithTools(input: ModelToolCompleteInput): Promise<FailoverToolCompleteOutput>;
}

export function createFailoverToolCallingClient(
  chain: readonly FailoverChainEntry[],
): FailoverToolCallingClient {
  if (chain.length === 0) {
    throw new Error("failover chain must not be empty");
  }

  return {
    async completeWithTools(input) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i]!;
        const model = entry.model;
        const req: ModelToolCompleteInput = {
          ...input,
          model,
        };
        try {
          const out = await entry.provider.completeWithTools(req);
          return {
            ...out,
            usedProviderId: entry.provider.id,
            usedModel: model,
            degraded: i > 0,
          };
        } catch (e) {
          lastErr = e;
          const more = i < chain.length - 1;
          if (more && isFailoverEligibleError(e)) continue;
          throw e;
        }
      }
      throw lastErr;
    },
  };
}
