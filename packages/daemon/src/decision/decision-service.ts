import { getLogger } from "../logging.js";
import type { ShoggothDecisionConfig } from "@shoggoth/shared";

const log = getLogger("decision-service");

// ---------------------------------------------------------------------------
// Decision (classifier) model support — TypeSafe System One API.
//
// Implements POST {baseUrl}/v1/systemone as specified at
// https://docs.typesafe.ai/api — a `state` is evaluated against a map of typed
// `questions` (`noul`, `choice`, `score`) and answers come back under the same
// question ids.
// ---------------------------------------------------------------------------

export interface DecisionProviderConfig {
  id: string;
  kind: "typesafe";
  baseUrl: string;
  apiKey: string;
  models: { name: string }[];
}

export interface DecisionEvaluateRequest {
  /** Model name; falls back to the configured `defaultModel` when omitted. */
  model?: string;
  /** Plain string, object, or array — the content to evaluate. */
  state: unknown;
  /** Map of typed questions: `noul`, `choice`, or `score`. */
  questions: Record<string, unknown>;
  timeout_ms?: number;
}

export type DecisionEvaluateResult =
  | {
      status: "complete";
      model: string;
      answers: Record<string, unknown>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }
  | { status: "error"; error: string };

export class DecisionService {
  private readonly providers: DecisionProviderConfig[];
  private readonly defaultModel?: string;

  constructor(config: { providers: DecisionProviderConfig[]; defaultModel?: string }) {
    this.providers = config.providers;
    this.defaultModel = config.defaultModel;
  }

  static fromConfig(config: ShoggothDecisionConfig): DecisionService {
    const providers: DecisionProviderConfig[] = (config.providers ?? []).map((p) => ({
      id: p.id,
      kind: "typesafe",
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? (p.apiKeyEnv ? (process.env[p.apiKeyEnv] ?? "") : ""),
      models: (p.models ?? []).map((m) => ({ name: m.name })),
    }));

    return new DecisionService({ providers, defaultModel: config.defaultModel });
  }

  /** Resolve a model name to the provider that serves it. */
  private resolveModel(model: string): DecisionProviderConfig | undefined {
    for (const provider of this.providers) {
      if (provider.models.some((m) => m.name === model)) {
        return provider;
      }
    }
    return undefined;
  }

  async evaluate(req: DecisionEvaluateRequest): Promise<DecisionEvaluateResult> {
    const model = req.model ?? this.defaultModel;
    if (!model) {
      return {
        status: "error",
        error: "model is required: no model given and no default model is configured",
      };
    }

    const provider = this.resolveModel(model);
    if (!provider) {
      return {
        status: "error",
        error: `No provider found for model: ${model}`,
      };
    }

    const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/systemone`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          state: req.state,
          model,
          questions: req.questions,
        }),
        ...(req.timeout_ms != null ? { signal: AbortSignal.timeout(req.timeout_ms) } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          status: "error",
          error: `Decision error ${response.status}: ${errorText}`,
        };
      }

      const json = (await response.json()) as {
        model?: string;
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      return {
        status: "complete",
        model: json.model ?? model,
        answers: json.answers ?? {},
        ...(json.usage ? { usage: json.usage } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("decision_service_evaluate_failed", { error: msg, model });
      return { status: "error", error: msg };
    }
  }
}
