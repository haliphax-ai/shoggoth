import { isFailoverEligibleError } from "./classify";
import type {
  ChatMessage,
  ModelCompleteInput,
  ModelCompleteOutput,
  ModelInvocationParams,
  ModelStreamTextDeltaCallback,
} from "./types";
import type { ModelProvider } from "./types";

export interface FailoverChainEntry {
  readonly provider: ModelProvider;
  readonly model: string;
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
}

export interface FailoverModelClient {
  complete(input: FailoverCompleteInput): Promise<FailoverCompleteOutput>;
}

export function createFailoverModelClient(
  chain: readonly FailoverChainEntry[],
): FailoverModelClient {
  if (chain.length === 0) {
    throw new Error("failover chain must not be empty");
  }

  return {
    async complete(input) {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i]!;
        const model = entry.model;
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
        };
        try {
          const out = await entry.provider.complete(req);
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
