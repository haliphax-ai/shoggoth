# Anthropic Messages API support (reference)

This document summarizes how **Anthropic Messages** is integrated in `@shoggoth/models` and how it lines up with config, environment, and readiness tooling.

## Goals (delivered)

- **`ModelProvider`** implementation: `complete` and `completeWithTools`, wired through **`createFailoverModelClient`** / **`createFailoverToolCallingClient`**.
- **Non-streaming** and **streaming** requests; streaming uses **`onTextDelta`** consistent with the OpenAI-compatible provider path.
- **`models.providers`** entries with `kind: "anthropic-messages"` and **`from-config.ts`** plumbing.
- **Readiness:** `tests/scripts/load-openclaw-env.mjs` exports `ANTHROPIC_*` when OpenClaw’s selected provider uses `api: "anthropic-messages"`. Override which provider block is read with **`SHOGGOTH_READINESS_PROVIDER`**, or force **`models.providers.lan`** with **`SHOGGOTH_READINESS_USE_LAN=1`**.

## Transport

- **URL:** `{origin}/v1/messages` with `baseUrl` normalized to **origin** (no `/v1` suffix in env).
- **Headers:** `anthropic-version`, `x-api-key` or `Authorization: Bearer` per provider **`auth`**.
- **Vendor-prefixed model ids:** if the gateway registers `namespace/model` but the HTTP API rejects slashes in `model`, Shoggoth strips through the **first** `/` before send (`normalizeAnthropicWireModelId`).

## Configuration examples

Layered JSON:

```json
{
  "models": {
    "providers": [
      {
        "id": "anthropic-local",
        "kind": "anthropic-messages",
        "baseUrl": "http://127.0.0.1:8000",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ],
    "failoverChain": [{ "providerId": "anthropic-local", "model": "claude-sonnet-4-20250514" }]
  }
}
```

Environment-only hop (no `failoverChain`): **`ANTHROPIC_BASE_URL`**, **`ANTHROPIC_API_KEY`**, **`SHOGGOTH_MODEL`**.

## Streaming / Discord

Discord enables streaming when **`SHOGGOTH_DISCORD_STREAM=1`** and the streaming outbound session starts; see `packages/daemon/src/platforms/discord.ts` and `session-tool-loop-model-client.ts`.

## Risks

- **Stream format drift** between upstream Anthropic and a self-hosted gateway: covered by parser tests; extend with stricter modes if needed.
