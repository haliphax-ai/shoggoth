// Phase 2 (GREEN) - Model Select Menu Utilities
// Custom ID encoding/decoding and select menu option builders

export interface SelectMenuOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly default?: boolean;
}

export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  models: ProviderModel[];
}

export interface FailoverChainEntry {
  providerId: string;
  modelId: string;
}

export type Step = "provider" | "model" | "custom_modal";

const CUSTOM_ID_PREFIX = "model_select|";

/**
 * Encodes a model select custom ID with step, session ID, and optional extra data.
 * Format: model_select|<step>|<sessionId>|<extra?>
 */
export function encodeModelSelectCustomId(step: Step, sessionId: string, extra?: string): string {
  const parts = ["model_select", step, sessionId];
  if (extra !== undefined) {
    parts.push(extra);
  }
  return parts.join("|");
}

/**
 * Decodes a model select custom ID into its components.
 * Returns null if the string doesn't start with 'model_select|'
 * or if the format is malformed.
 */
export function decodeModelSelectCustomId(
  customId: string,
): { step: Step; sessionId: string; extra?: string } | null {
  if (!customId.startsWith(CUSTOM_ID_PREFIX)) {
    return null;
  }

  const parts = customId.substring(CUSTOM_ID_PREFIX.length).split("|");

  // Must have at least step and sessionId
  if (parts.length < 2) {
    return null;
  }

  const step = parts[0];
  const sessionId = parts[1];
  const extra = parts[2];

  // Validate step is one of the expected values
  if (step !== "provider" && step !== "model" && step !== "custom_modal") {
    return null;
  }

  return {
    step,
    sessionId,
    extra: extra !== undefined ? extra : undefined,
  };
}

/**
 * Builds provider select menu options.
 * First option is '(custom)' with value '__custom__',
 * followed by one option per provider.
 */
export function buildProviderSelectOptions({
  providers,
  currentProviderId,
}: {
  providers: ProviderConfig[];
  currentProviderId?: string;
}): SelectMenuOption[] {
  const options: SelectMenuOption[] = [
    {
      label: "(custom)",
      value: "__custom__",
      description: "Enter provider/model manually",
    },
  ];

  // Cap at 25 total options (1 custom + up to 24 providers)
  const maxProviders = 24;
  const providersToAdd = providers.slice(0, maxProviders);

  for (const provider of providersToAdd) {
    const option: SelectMenuOption =
      provider.id === currentProviderId
        ? { label: provider.name, value: provider.id, default: true }
        : { label: provider.name, value: provider.id };

    options.push(option);
  }

  return options;
}

/**
 * Builds model select menu options for a specific provider.
 * Collects models from provider.models[] and failoverChain entries.
 * Deduplicates model names and caps at 25 options.
 */
export function buildModelSelectOptions({
  providerId,
  providers,
  failoverChain,
  currentModel,
}: {
  providerId: string;
  providers: readonly ProviderConfig[];
  failoverChain: readonly FailoverChainEntry[];
  currentModel?: string;
}): SelectMenuOption[] {
  // Find the provider
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    return [];
  }

  // Collect model ids and names from provider.models[]
  const modelsById = new Map<string, string>(); // id -> name
  for (const model of provider.models) {
    modelsById.set(model.id, model.name);
  }

  // Collect model ids from failoverChain entries matching this provider
  for (const entry of failoverChain) {
    if (entry.providerId === providerId) {
      // Use modelId as both id and name for failover entries
      if (!modelsById.has(entry.modelId)) {
        modelsById.set(entry.modelId, entry.modelId);
      }
    }
  }

  // Build options array
  const options: SelectMenuOption[] = [];
  for (const [modelId, modelName] of modelsById) {
    const option: SelectMenuOption =
      modelId === currentModel
        ? { label: modelName, value: modelId, default: true }
        : { label: modelName, value: modelId };

    options.push(option);
  }
  // Cap at 25 options
  return options.slice(0, 25);
}
