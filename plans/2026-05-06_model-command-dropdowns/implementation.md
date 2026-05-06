# Implementation

## Phase 1: Transport & Payload Infrastructure

Widen the transport interface and gateway payload parser to support component interactions (type 3), modal submissions (type 5), and the new response types (6, 7, 9).

- Widen `interactionCallback` body type in `transport.ts` to accept `components`, `flags`, `custom_id`, `title` in `data`
- Extend `DiscordInteractionEvent` in `interaction.ts` to carry component/modal fields (`custom_id`, `values`, `components`, `component_type`, `message`)
- Update `discordInteractionCreateToEvent` in `gateway-payload.ts` to parse interaction types 3 and 5 (extract `custom_id`, `values[]`, modal `components`)
- Add constants for new interaction types and response types

**Files:**

- `packages/platform-discord/src/transport.ts`
- `packages/platform-discord/src/interaction.ts`
- `packages/platform-discord/src/gateway-payload.ts`
- `packages/platform-discord/test/gateway-payload-interaction.test.ts`
- `packages/platform-discord/test/discord-interaction.test.ts`

## Phase 2: custom_id Encoding & Select Menu Builders

Implement the utility functions for encoding/decoding `custom_id` strings and building Select Menu option arrays from config data.

- Create `src/model-select.ts` with:
  - `encodeModelSelectCustomId(step, sessionId, extra?)`
  - `decodeModelSelectCustomId(customId)` — returns parsed parts or null
  - `buildProviderSelectOptions(providers, currentProviderId?)` — returns options with `(custom)` first, current marked default
  - `buildModelSelectOptions(provider, failoverChain, currentModel?)` — returns model options with current marked default
- Unit tests for encoding/decoding round-trips, edge cases (special chars in session IDs)
- Unit tests for option builders (empty providers, 25+ models truncation, default marking)

**Files:**

- `packages/platform-discord/src/model-select.ts`
- `packages/platform-discord/test/model-select.test.ts`

## Phase 3: Slash Command Definition Update

Update the `/model` command registration to remove `model_selection` and keep only `session_id` and `agent_id`. The command now always responds with the interactive dropdown flow.

- Remove `model_selection` option from the `/model` entry in `GLOBAL_SLASH_COMMANDS`
- Update the `session_model` handler block in `handleInteraction` to respond with the provider Select Menu instead of directly querying/setting the model
- Add `getModelsConfig` to `DiscordInteractionHandlerDeps` interface
- Wire `getModelsConfig` in the platform bootstrap (reads from daemon config)

**Files:**

- `packages/platform-discord/src/slash-commands.ts`
- `packages/platform-discord/src/bootstrap.ts` (or wherever deps are wired)
- `packages/platform-discord/test/slash-commands.test.ts`

## Phase 4: Component Interaction Handler

Handle the Select Menu interactions (type 3) and Modal submissions (type 5) to complete the multi-step flow.

- In `handleInteraction`, add branches for interaction types 3 and 5
- For type 3: decode `custom_id`, dispatch based on step:
  - `"provider"` + value `"__custom__"` → respond with Modal (type 9)
  - `"provider"` + real provider → respond with model Select Menu (type 7 update)
  - `"model"` → execute `session_model` control op, respond with result (type 7 update, clear components)
- For type 5: decode `custom_id`, extract text input value, validate `provider/model` format, execute `session_model`, respond with result
- Handle errors gracefully (unknown custom_id prefix → ignore, invalid model format → error message)

**Files:**

- `packages/platform-discord/src/slash-commands.ts`
- `packages/platform-discord/test/slash-commands.test.ts`
- `packages/platform-discord/test/discord-interaction.test.ts`

## Phase 5: Default Value Resolution

When the `/model` command is invoked, query the session's current model to pre-select the correct provider and model in the dropdowns.

- On `/model` invocation, call `invokeControlOp("session_model", { session_id })` to get current `effective_models` (providerId + model)
- Pass `currentProviderId` to `buildProviderSelectOptions`
- When provider is selected and matches the current provider, pass `currentModel` to `buildModelSelectOptions`
- Handle case where session has no model set (no defaults, just placeholder text)

**Files:**

- `packages/platform-discord/src/slash-commands.ts`
- `packages/platform-discord/test/slash-commands.test.ts`

## Phase 6: Integration Testing & Cleanup

End-to-end verification of the full flow and cleanup.

- Integration test: invoke `/model` → verify ephemeral response with provider select → simulate provider selection → verify model select response → simulate model selection → verify `session_model` called
- Integration test: custom modal flow
- Integration test: no providers configured → falls back to modal directly
- Verify command re-registration picks up the new definition (remove old `model_selection` option)
- Update `packages/platform-discord/src/index.ts` exports if needed

**Files:**

- `packages/platform-discord/test/slash-commands.test.ts`
- `packages/platform-discord/test/discord-interaction.test.ts`
