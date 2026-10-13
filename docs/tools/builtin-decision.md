Query a decision (classifier) model — evaluates a state against typed questions and returns structured answers with probabilities. Backed by TypeSafe System One models (`POST /v1/systemone`, see <https://docs.typesafe.ai/api>).

**Feature gating:** the feature only exists when the `decision` config section has at least one provider with at least one model. When it does not, the `builtin-decision` tool is not injected, the `decision_evaluate` control op responds as an unknown op, and the `shoggoth decision` CLI command (including its help and its entry in `shoggoth --help`) is inert/hidden.

## Parameters

| Param        | Type   | Required | Notes                                                                                           |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| `model`      | string | no¹      | Decision model name (e.g. `jev-latest`, `jev-1.13.0`). Omit to use the configured default model |
| `state`      | any    | yes      | The content to evaluate: a plain string, object, or array (e.g. chat logs, app state)           |
| `questions`  | object | yes      | Map of question id → typed question (see below)                                                 |
| `timeout_ms` | number | no       | Request timeout in milliseconds                                                                 |

¹ Falls back to the `decision.defaultModel` configured model. When no default is configured, `model` is required.

## Question types

Every question has a `type` and `instructions` (string, object, or array). Each type adds its own `criteria`.

### `noul`

A yes/no question. Returns the probability the answer is yes (0–1).

| Field          | Type   | Required | Description                                                  |
| -------------- | ------ | -------- | ------------------------------------------------------------ |
| `type`         | string | yes      | `"noul"`                                                     |
| `instructions` | any    | yes      | The yes/no question to evaluate                              |
| `criteria`     | object | no       | Optional `{ "true": ..., "false": ... }` rubric descriptions |

### `choice`

Picks one option from a set you define. Returns the chosen option, the full probability distribution, and a confidence (0–1).

| Field          | Type   | Required | Description                                                            |
| -------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `type`         | string | yes      | `"choice"`                                                             |
| `instructions` | any    | yes      | What the model should decide                                           |
| `criteria`     | object | yes      | Map of option → rubric description (`null` for none). Max 255 options. |

### `score`

Rates the state along an ordered rubric. Returns a probability-weighted score, a legend, the distribution, and a confidence (0–1).

| Field          | Type   | Required | Description                              |
| -------------- | ------ | -------- | ---------------------------------------- |
| `type`         | string | yes      | `"score"`                                |
| `instructions` | any    | yes      | What the model should rate               |
| `criteria`     | array  | yes      | Ordered array of 2–10 level descriptions |

## Examples

**Noul:**

```json
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
  }
}
```

**Choice:**

```json
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    }
  }
}
```

**Score:**

```json
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

## Result

Answers come back under the same question ids, with `usage` token counts:

```json
{
  "status": "complete",
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 }
  },
  "usage": { "input_tokens": 307, "output_tokens": 20 }
}
```

## Configuration

```json
{
  "decision": {
    "defaultModel": "jev-latest",
    "providers": [
      {
        "id": "typesafe-main",
        "kind": "typesafe",
        "baseUrl": "https://api.typesafe.ai",
        "apiKeyEnv": "TYPESAFE_API_KEY",
        "models": [{ "name": "jev-latest" }]
      }
    ]
  }
}
```

`defaultModel` must match a model listed under a configured provider; the config schema rejects it otherwise. When set, the tool descriptor tells the agent which model/provider combo serves as the default.

## CLI

```
shoggoth decision evaluate --state "Is this urgent?" \
  --questions '{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}'
shoggoth decision evaluate --model jev-1.13.0 --state "Is this urgent?" \
  --questions '{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}'
shoggoth decision models
```

`--model` is optional and falls back to `decision.defaultModel`. `decision models` marks the default with `(default)`.
