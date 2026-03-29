# Messaging (Discord) — environment and routing

The daemon uses `@shoggoth/messaging` for the internal message model, capability descriptors, Discord Gateway inbound, REST outbound, streaming edits, and an in-process agent-to-agent bus.

## Required for Discord bridge

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord application (same value as in the developer portal). Used for Gateway `IDENTIFY` and REST `Authorization: Bot …`. **Do not commit**; inject via Compose secret or env. If unset, the daemon uses layered config `discord.botToken` (see below). When both are set, **env wins**. |

Alternatively, set **`discord.botToken`** in a layered JSON config fragment (same string as the portal token). The readiness **discord** health probe uses the same resolution order. `shoggoth config-show` prints the effective config — **redact** tokens if you share output.

## Routing (inbound + outbound)

| Variable | Purpose |
|----------|---------|
| `SHOGGOTH_DISCORD_ROUTES` | JSON **array** of objects: `{ "channelId": string, "sessionId": string, "guildId"?: string }`. Maps Discord channels (or DM channel ids) to internal session ids. **Guild channels** should include `guildId` so routing matches gateway payloads. **DMs** omit `guildId`. |

## Optional

| Variable | Purpose |
|----------|---------|
| `SHOGGOTH_DISCORD_INTENTS` | Decimal gateway intents override. Default includes guild + DM message intents and **Message Content Intent** (`37377`). Enable that privileged intent in the Discord portal for guild text content. |
| `SHOGGOTH_DISCORD_ALLOW_BOT` | Set to `1` to deliver `MESSAGE_CREATE` events whose author is a bot (default ignores bots to avoid feedback loops). |
| `SHOGGOTH_DISCORD_STREAM` | Set to `1` to open a placeholder Discord message and **stream model output live**: each `completeWithTools` hop uses OpenAI-style SSE (`stream: true` in `@shoggoth/models`), and the Discord platform throttles `editMessage` calls with **`SHOGGOTH_DISCORD_STREAM_MIN_MS`** (default **400** ms) to stay under Discord rate limits. After the tool loop, the message is patched once with the degraded banner + optional model tag + final transcript text. |
| `SHOGGOTH_DISCORD_MODEL_TAG` | Set to `1` to append a small italic operator footer on **successful** Discord replies: `_model: … · provider: …_` (from the last failover hop), including when not degraded. |

**Error** replies to Discord map common failures to short user-visible copy (`ModelHttpError` statuses such as 429 / 5xx / 401, fetch-like `TypeError`, `hitl_pending:*` with pending id); full errors are still logged server-side.

## Behaviour

- **Inbound:** Gateway `MESSAGE_CREATE` → adapter → `InternalMessage` → `AgentToAgentBus.deliver(sessionId, …)` plus a structured log line (`discord.inbound`).
- **Outbound:** `OutboundSender.sendDiscord` and `createDiscordStreamingOutbound` use the same REST transport and `discordCapabilityDescriptor()`.
- **Discord REST rate limits:** `createDiscordRestTransport` automatically retries failed **create** and **edit** requests on HTTP **429** (and on **503** when Discord sends a `Retry-After` header). Waits follow `retry_after` in the JSON body when present, else the `Retry-After` header (seconds); attempts and total wait time are capped so outbound Discord traffic does not hang indefinitely.
- **Shutdown:** the daemon registers a `discord-messaging` drain that closes the Gateway WebSocket and clears heartbeats.

CI and unit tests use mocked `fetch` / Gateway connections; live Discord is not required.
