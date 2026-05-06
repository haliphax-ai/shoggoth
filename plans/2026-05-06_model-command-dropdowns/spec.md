# Specification

## Interfaces

### New Discord Interaction Types

```ts
/** Discord interaction type 3 — user interacted with a message component. */
const MESSAGE_COMPONENT = 3;

/** Discord interaction type 5 — user submitted a modal. */
const MODAL_SUBMIT = 5;

/** Interaction callback type 6 — acknowledge a component interaction (no visible response). */
const INTERACTION_RESPONSE_DEFERRED_UPDATE = 6;

/** Interaction callback type 7 — edit the message the component is on. */
const INTERACTION_RESPONSE_UPDATE_MESSAGE = 7;

/** Interaction callback type 9 — respond with a modal popup. */
const INTERACTION_RESPONSE_MODAL = 9;
```

### Component Interaction Event

```ts
/** Extends DiscordInteractionEvent for component interactions (type 3). */
interface DiscordComponentInteractionEvent {
  readonly kind: "interaction_create";
  readonly id: string;
  readonly token: string;
  readonly type: 3; // MESSAGE_COMPONENT
  readonly channelId: string;
  readonly guildId?: string;
  readonly userId: string;
  readonly message?: { readonly id: string }; // The message the component is attached to
  readonly data: {
    /** Component type (3 = StringSelect). */
    readonly component_type: number;
    /** The custom_id of the component that was interacted with. */
    readonly custom_id: string;
    /** Selected values (for select menus). */
    readonly values?: readonly string[];
  };
}
```

### Modal Submit Event

```ts
/** Extends DiscordInteractionEvent for modal submissions (type 5). */
interface DiscordModalSubmitEvent {
  readonly kind: "interaction_create";
  readonly id: string;
  readonly token: string;
  readonly type: 5; // MODAL_SUBMIT
  readonly channelId: string;
  readonly guildId?: string;
  readonly userId: string;
  readonly data: {
    /** The custom_id of the modal. */
    readonly custom_id: string;
    /** Submitted components (action rows containing text inputs). */
    readonly components: ReadonlyArray<{
      readonly type: 1; // ACTION_ROW
      readonly components: ReadonlyArray<{
        readonly type: 4; // TEXT_INPUT
        readonly custom_id: string;
        readonly value: string;
      }>;
    }>;
  };
}
```

### custom_id Encoding

```ts
/**
 * Encode session context into a component custom_id.
 * Format: "model_select:<step>:<sessionId>[:<extra>]"
 *
 * Steps:
 *   "provider"       — provider select menu (extra: none)
 *   "model"          — model select menu (extra: providerId)
 *   "custom_modal"   — modal for free-text input (extra: none)
 */
function encodeModelSelectCustomId(
  step: "provider" | "model" | "custom_modal",
  sessionId: string,
  extra?: string,
): string;

/**
 * Decode a custom_id back into its parts. Returns null if not a model_select id.
 */
function decodeModelSelectCustomId(customId: string): {
  step: "provider" | "model" | "custom_modal";
  sessionId: string;
  extra?: string;
} | null;
```

### Select Menu Option Builder

```ts
interface SelectMenuOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly default?: boolean;
}

/**
 * Build provider select menu options from config.
 * @param providers - Array of configured provider entries.
 * @param currentProviderId - The session's current provider (marked as default).
 * @returns Options array with (custom) at the top, max 25 total.
 */
function buildProviderSelectOptions(
  providers: ReadonlyArray<{ readonly id: string }>,
  currentProviderId?: string,
): SelectMenuOption[];

/**
 * Build model select menu options for a specific provider.
 * @param provider - The provider config entry (with optional models[] array).
 * @param failoverChain - The failover chain entries for this provider.
 * @param currentModel - The session's current model (marked as default).
 * @returns Options array, max 25 total.
 */
function buildModelSelectOptions(
  provider: { readonly id: string; readonly models?: ReadonlyArray<{ readonly name: string }> },
  failoverChain: ReadonlyArray<{ readonly providerId: string; readonly model: string }>,
  currentModel?: string,
): SelectMenuOption[];
```

### Transport Extensions

```ts
// The interactionCallback body type needs widening:
interface InteractionCallbackBody {
  readonly type: number;
  readonly data?: {
    readonly content?: string;
    readonly flags?: number;
    /** Message components (action rows). */
    readonly components?: ReadonlyArray<Record<string, unknown>>;
    /** Modal fields (custom_id, title, components). */
    readonly custom_id?: string;
    readonly title?: string;
    /** Autocomplete choices (not used here but for completeness). */
    readonly choices?: ReadonlyArray<Record<string, unknown>>;
  };
}
```

### Handler Dependencies Extension

```ts
interface DiscordInteractionHandlerDeps {
  // ...existing deps...

  /**
   * Read the models config to enumerate providers and their models.
   * Returns the providers array and parsed failover chain.
   */
  readonly getModelsConfig?: () => {
    providers: ReadonlyArray<{
      id: string;
      kind: string;
      models?: ReadonlyArray<{
        name: string;
        contextWindowTokens?: number;
        thinkingFormat?: string;
      }>;
    }>;
    failoverChain: ReadonlyArray<{ providerId: string; model: string }>;
  } | null;
}
```

## Data Structures

### Ephemeral Flag

```ts
/** Message flag for ephemeral (only visible to invoking user). */
const EPHEMERAL_FLAG = 1 << 6; // 64
```

### Action Row with StringSelect

```ts
// Component types
const ACTION_ROW = 1;
const STRING_SELECT = 3;
const TEXT_INPUT = 4;

// Text input styles
const TEXT_INPUT_SHORT = 1;
const TEXT_INPUT_PARAGRAPH = 2;
```

## Code Examples

### Responding with a Provider Select Menu

```ts
await transport.interactionCallback(interactionId, interactionToken, {
  type: INTERACTION_RESPONSE_CHANNEL_MESSAGE, // 4
  data: {
    content: "🎯 **Model Selection**\nCurrent: `anthropic/claude-3-5-sonnet`\n\nSelect a provider:",
    flags: EPHEMERAL_FLAG,
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: STRING_SELECT,
            custom_id: encodeModelSelectCustomId("provider", sessionId),
            placeholder: "Select a provider...",
            options: buildProviderSelectOptions(providers, "anthropic"),
          },
        ],
      },
    ],
  },
});
```

### Responding to Provider Selection with Model Menu

```ts
await transport.interactionCallback(interactionId, interactionToken, {
  type: INTERACTION_RESPONSE_UPDATE_MESSAGE, // 7
  data: {
    content: `🎯 **Model Selection**\nProvider: \`${providerId}\`\n\nSelect a model:`,
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: STRING_SELECT,
            custom_id: encodeModelSelectCustomId("model", sessionId, providerId),
            placeholder: "Select a model...",
            options: buildModelSelectOptions(provider, failoverChain, currentModel),
          },
        ],
      },
    ],
  },
});
```

### Responding with a Modal for Custom Input

```ts
await transport.interactionCallback(interactionId, interactionToken, {
  type: INTERACTION_RESPONSE_MODAL, // 9
  data: {
    custom_id: encodeModelSelectCustomId("custom_modal", sessionId),
    title: "Custom Model",
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: TEXT_INPUT,
            custom_id: "model_input",
            label: "Model (provider/model format)",
            style: TEXT_INPUT_SHORT,
            placeholder: "anthropic/claude-3-5-sonnet",
            required: true,
            min_length: 3,
            max_length: 128,
          },
        ],
      },
    ],
  },
});
```

### Executing the Model Change

```ts
// After user selects model or submits modal:
const modelSelection = `${providerId}/${modelName}`;
const result = await deps.invokeControlOp("session_model", {
  session_id: sessionId,
  model_selection: modelSelection,
});

// Update the message with the result
await transport.interactionCallback(interactionId, interactionToken, {
  type: INTERACTION_RESPONSE_UPDATE_MESSAGE, // 7
  data: {
    content: result.ok ? `✅ Model set to \`${modelSelection}\`` : `⚠️ Failed: ${result.error}`,
    components: [], // Remove the select menus
  },
});
```
