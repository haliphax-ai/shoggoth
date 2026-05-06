---
date: 2026-05-06
completed: never
---

# /model Slash Command — Select Menu Dropdowns

## Summary

Replace the `/model` command's plain text `model_selection` option with an interactive multi-step Select Menu flow. The user picks a provider from a dropdown, then picks a model from a second dropdown populated based on that provider. A `(custom)` provider option triggers a Modal for free-text `provider/model` input. Dropdowns default to the session's current provider and model.

## Motivation

The current `/model` command requires the user to know and type the exact `provider/model` string. This is error-prone and undiscoverable. Discord's Select Menu components provide a guided, visual dropdown experience that shows available options and pre-selects the current value — making model switching faster and less error-prone.

## Design

### Interaction Flow

```
User invokes /model
       │
       ▼
Bot responds (ephemeral) with:
  - Current model info text
  - Action Row: Provider StringSelect (default = current provider)
       │
       ▼
User selects a provider (component interaction type 3)
       │
       ├─ Provider = "(custom)"
       │       │
       │       ▼
       │   Bot responds with Modal (text input: "provider/model")
       │       │
       │       ▼
       │   User submits modal (interaction type 5)
       │       │
       │       ▼
       │   Bot executes model change, edits message with result
       │
       ├─ Provider = a configured provider
       │       │
       │       ▼
       │   Bot updates message with:
       │     - Model StringSelect (default = current model if same provider)
       │       │
       │       ▼
       │   User selects a model (component interaction type 3)
       │       │
       │       ▼
       │   Bot executes model change, edits message with result
       │
       └─ (no selection / timeout) → message expires naturally
```

### Key Design Decisions

1. **Ephemeral messages** — The dropdown flow is only visible to the invoking user (flag `1 << 6 = 64`). Avoids channel clutter.

2. **State encoded in `custom_id`** — Each Select Menu component carries a `custom_id` that encodes the session context (e.g. `model_select:provider:<sessionId>` and `model_select:model:<sessionId>:<providerId>`). This avoids needing server-side state between interactions.

3. **Default values** — The `default_values` / pre-selected option on each Select Menu reflects the session's current provider/model so the user can see what's active.

4. **25-option limit** — Discord caps Select Menus at 25 options. If a provider has more than 24 models, the list is truncated with a note to use `(custom)`. The `(custom)` entry always occupies the first slot.

5. **Config access** — The component interaction handler needs read access to `models.providers[]` and their `models[]` arrays from the Shoggoth config, plus the ability to call `session_model` to read/write the current model.

6. **Removing old options** — The `model_selection` STRING option is removed from the command definition. The `session_id` and `agent_id` options remain for targeting a specific session.

### New Interaction Types Handled

| Discord Type | Constant            | Purpose                                  |
| ------------ | ------------------- | ---------------------------------------- |
| 3            | `MESSAGE_COMPONENT` | User selects from a dropdown             |
| 5            | `MODAL_SUBMIT`      | User submits the custom model text input |

### Component Structure

Provider Select Menu (Action Row):

```json
{
  "type": 1,
  "components": [
    {
      "type": 3,
      "custom_id": "model_select:provider:<sessionId>",
      "placeholder": "Select a provider...",
      "options": [
        {
          "label": "(custom)",
          "value": "__custom__",
          "description": "Enter provider/model manually"
        },
        { "label": "anthropic", "value": "anthropic", "default": true },
        { "label": "openai", "value": "openai" }
      ]
    }
  ]
}
```

Model Select Menu (Action Row):

```json
{
  "type": 1,
  "components": [
    {
      "type": 3,
      "custom_id": "model_select:model:<sessionId>:<providerId>",
      "placeholder": "Select a model...",
      "options": [
        { "label": "claude-3-5-sonnet", "value": "claude-3-5-sonnet", "default": true },
        { "label": "claude-3-opus", "value": "claude-3-opus" }
      ]
    }
  ]
}
```

Modal (for custom input):

```json
{
  "type": 9,
  "data": {
    "custom_id": "model_select:custom_modal:<sessionId>",
    "title": "Custom Model",
    "components": [
      {
        "type": 1,
        "components": [
          {
            "type": 4,
            "custom_id": "model_input",
            "label": "Model (provider/model format)",
            "style": 1,
            "placeholder": "anthropic/claude-3-5-sonnet",
            "required": true
          }
        ]
      }
    ]
  }
}
```

## Testing Strategy

- **Unit tests** for the new component interaction parser (type 3 and type 5 payloads)
- **Unit tests** for Select Menu option builder (provider list, model list, default selection logic)
- **Unit tests** for `custom_id` encoding/decoding
- **Integration test** for the full flow: invoke → provider select → model select → verify `session_model` called with correct payload
- **Integration test** for the custom modal flow
- **Edge cases**: session with no model set (no defaults), provider with 25+ models (truncation), unknown `custom_id` prefix (ignored gracefully)

## Considerations

- The 25-option limit means very large provider model lists need truncation. The `(custom)` escape hatch covers this.
- Component interactions have a 3-second acknowledgment deadline. The handler should `deferUpdate` (type 6) if it needs more time to fetch config/session state, then edit the message.
- Ephemeral messages can't be edited after 15 minutes — the dropdowns will stop working after that. This is acceptable for a quick model-switch flow.
- The `session_id` and `agent_id` options on the slash command still work for targeting. The resolved session ID is encoded into `custom_id` so subsequent component interactions know which session to modify.
- If the config has no `models.providers[]` defined (env-var-only setup), the provider dropdown would be empty. In that case, skip the dropdown flow and show the modal directly.

## Migration

No data migration needed. The slash command definition changes (removing `model_selection`, keeping `session_id`/`agent_id`). Discord will pick up the new definition on the next `registerGlobalCommands` call. Old cached command UIs in clients will refresh automatically.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [Discord Component Reference](https://discord.com/developers/docs/components/reference)
- [Discord Receiving and Responding](https://docs.discord.com/developers/interactions/receiving-and-responding)
