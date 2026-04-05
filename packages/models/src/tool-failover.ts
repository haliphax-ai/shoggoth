import { isFailoverEligibleError } from "./classify";
import type { FailoverChainEntry } from "./failover";
import type { ModelCapabilities, ModelToolCompleteInput, ModelToolCompleteOutput } from "./types";
import { stripXmlThinkingTags } from "./thinking-normalize";

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
          const thinkingFormat = input.thinkingFormat ?? entry.provider.capabilities?.thinkingFormat;
          const toolCalls = thinkingFormat === "xml-tags"
            ? out.toolCalls.map((tc) => ({ ...tc, arguments: stripXmlThinkingTags(tc.arguments) }))
            : out.toolCalls;
          return {
            ...out,
            toolCalls,
            usedProviderId: entry.provider.id,
            usedModel: model,
            degraded: i > 0,
            thinkingFormat,
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
