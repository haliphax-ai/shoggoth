# Platform Discord — Reference

Shoggoth's Discord integration package (`@shoggoth/platform-discord`) connects agents to Discord via the Gateway WebSocket API and REST v10. It is bootstrapped by the [daemon](daemon.md#platform-integration) at startup. It handles bot authentication, message routing, thread management, reactions, attachments, streaming responses, slash commands, and human-in-the-loop (HITL) approval flows.

---

## Architecture Overview

The package is organized into these layers:

1. **Gateway Client** — WebSocket connection to Discord's Gateway (v10, JSON encoding) with heartbeat, resume, and exponential-backoff reconnection.
2. **REST Transport** — Typed HTTP client for Discord REST v10 with automatic rate-limit retry (429/503), jitter, and budget caps.
3. **Adapter** — Maps raw Discord `MESSAGE_CREATE` events to platform-agnostic `InternalMessage` objects, resolving the target Shoggoth session via configured routes.
4. **Bridge** — Orchestrates gateway + adapter + outbound sender + agent-to-agent bus. The central runtime object (`DiscordMessagingRuntime`).
5. **Platform** — Wires the bridge into the daemon: session stores, transcript, tool execution, HITL, MCP, policy engine, streaming, and turn queuing.
6. **Platform Adapter** — Presentation-layer adapter (`DiscordPlatformAdapter`) that owns transport concerns: message splitting, typing indicators, streaming placeholders, HITL notice delivery.
7. **Slash Commands & Interactions** — Registers global slash commands and handles `INTERACTION_CREATE` events as control operations.
8. **HITL Subsystem** — Reaction-based approval/denial on Discord notices, with a notice registry, notifier, and reaction handler.

---

## Configuration

Discord config is resolved from `platforms.discord` in the Shoggoth config (or the deprecated top-level `discord` key). See [Shared — Configuration Schema](shared.md#configuration-schema) for the full config surface. Environment variables take precedence where noted.

### Config Schema (Zod-validated)

| Field                  | Type       | Description                                                                                                                                                                   |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                | `string?`  | Bot token. The env var named by `tokenEnv` wins when set; `DISCORD_BOT_TOKEN` is the default when `tokenEnv` is absent.                                                       |
| `tokenEnv`             | `string?`  | Name of the env var holding the bot token (the `*Env` convention used elsewhere in the configuration). Default: `DISCORD_BOT_TOKEN`.                                          |
| `ownerUserId`          | `string?`  | Discord snowflake of the operator. Env `SHOGGOTH_DISCORD_OWNER_USER_ID` wins. When set, only this user's messages are processed on non-subagent sessions.                     |
| `intents`              | `number?`  | Gateway intents bitmask. Env `SHOGGOTH_DISCORD_INTENTS` wins. Default: guilds + guild messages + guild message reactions + DMs + DM reactions + message content (privileged). |
| `allowBotMessages`     | `boolean?` | Process messages from other bots. Env `SHOGGOTH_DISCORD_ALLOW_BOT` (`1`/`0`). Default `false`.                                                                                |
| `hitlNotifyDmUserId`   | `string?`  | Send HITL notices as DMs to this user. Env `SHOGGOTH_HITL_NOTIFY_DM_USER_ID`.                                                                                                 |
| `hitlNotifyChannelId`  | `string?`  | Post HITL notices to this channel. Env `SHOGGOTH_HITL_NOTIFY_CHANNEL_ID`.                                                                                                     |
| `hitlNotifyWebhookUrl` | `string?`  | POST HITL events as JSON to this webhook. Env `SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL`.                                                                                             |

### Additional Env-Driven Settings

| Env Variable                               | Effect                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `SHOGGOTH_DISCORD_STREAM=1`                | Enable streaming responses (edit-in-place).            |
| `SHOGGOTH_DISCORD_STREAM_MIN_MS`           | Minimum interval between stream edits (default 400ms). |
| `SHOGGOTH_DISCORD_MODEL_TAG=1`             | Append model tag footer to replies.                    |
| `SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0` | Disable in-session HITL queued notices.                |
| `SHOGGOTH_AGENT_ID`                        | Override the resolved agent ID (default `main`).       |

### Routes

Routes map Discord channels to Shoggoth sessions. They are defined per-agent under `agents.list.<agentId>.platforms.discord.routes` as a JSON array:

```json
[
  {
    "channelId": "1234567890123456789",
    "sessionId": "agent:main:discord:channel:1234567890123456789",
    "guildId": "9876543210987654321"
  }
]
```

- `channelId` — Discord channel snowflake (17–22 digit string).
- `sessionId` — Agent session URN. Must match the agent ID from the config key. See [Shared — Session URNs](shared.md#session-urns) for the URN format `agent:<agentId>:<platform>:<resourceType>:<leafId>`.
- `guildId` — Optional guild snowflake for disambiguation when the same channel ID appears in multiple guilds.

Routes with invalid session URNs are silently dropped. A route whose leaf snowflake doesn't match `channelId` (when both are snowflakes) is a fatal configuration error.

---

## Gateway Client

`connectDiscordGateway(options)` establishes a WebSocket session:

- Fetches the gateway URL from `GET /gateway/bot`.
- Sends `IDENTIFY` (op 2) with bot token, intents, and `os: linux, browser: shoggoth, device: shoggoth`.
- Maintains heartbeat on the interval from `HELLO` (op 10). Detects zombie connections via missed heartbeat ACKs.
- Handles `READY` (extracts bot user ID, session ID, resume URL), `RESUMED`, `MESSAGE_CREATE`, `MESSAGE_REACTION_ADD`, and `INTERACTION_CREATE`.
- On op 7 (Reconnect) or op 9 (Invalid Session), closes and reconnects. Resumable sessions use op 6; non-resumable sessions re-identify.
- Exponential backoff: base 1s, max 30s, up to 10 consecutive attempts before giving up.

### Default Intents

```
GUILDS (1<<0) + GUILD_MESSAGES (1<<9) + GUILD_MESSAGE_REACTIONS (1<<10) +
DIRECT_MESSAGES (1<<12) + DIRECT_MESSAGE_REACTIONS (1<<13) + MESSAGE_CONTENT (1<<15)
```

The Message Content intent is privileged and must be enabled in the Discord Developer Portal.

---

## REST Transport

`createDiscordRestTransport({ botToken })` returns a `DiscordRestTransport` with these operations:

| Method                            | Discord Endpoint                                  | Notes                                                    |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `createMessage`                   | `POST /channels/{id}/messages`                    | JSON body                                                |
| `createMessageWithFiles`          | `POST /channels/{id}/messages`                    | `multipart/form-data` with `payload_json` + `files[n]`   |
| `editMessage`                     | `PATCH /channels/{id}/messages/{id}`              |                                                          |
| `deleteMessage`                   | `DELETE /channels/{id}/messages/{id}`             |                                                          |
| `getMessage`                      | `GET /channels/{id}/messages/{id}`                |                                                          |
| `getChannelMessages`              | `GET /channels/{id}/messages`                     | Supports `before`, `after`, `around`, `limit` (max 100)  |
| `createThreadFromMessage`         | `POST /channels/{id}/messages/{id}/threads`       | Returns new thread channel ID                            |
| `deleteChannel`                   | `DELETE /channels/{id}`                           | Also deletes threads                                     |
| `createMessageReaction`           | `PUT .../reactions/{emoji}/@me`                   | Unicode or `name:id` for custom                          |
| `deleteMessageReaction`           | `DELETE .../reactions/{emoji}/@me`                | Bot's own reaction only                                  |
| `getMessageReactions`             | `GET .../reactions/{emoji}`                       |                                                          |
| `searchMessages`                  | `GET /guilds/{id}/messages/search`                | `content`, `author_id`, `channel_id`, `min_id`, `max_id` |
| `triggerTypingIndicator`          | `POST /channels/{id}/typing`                      | Lasts ~10s                                               |
| `openDmChannel`                   | `POST /users/@me/channels`                        | Returns DM channel ID                                    |
| `interactionCallback`             | `POST /interactions/{id}/{token}/callback`        | Slash command responses                                  |
| `registerGlobalCommands`          | `PUT /applications/{id}/commands`                 | Bulk overwrite                                           |
| `editOriginalInteractionResponse` | `PATCH /webhooks/{id}/{token}/messages/@original` | Deferred responses                                       |

### Rate Limit Handling

- Up to 6 retry attempts on HTTP 429 (and 503 with `Retry-After`).
- Respects `retry_after` from JSON body or `Retry-After` header.
- Adds random jitter (0–250ms) after each suggested wait.
- Total wait budget capped at 90 seconds.
- Falls back to 1s delay when 429 has no `retry_after`.

---

## Message Routing (Inbound)

1. Gateway delivers `MESSAGE_CREATE` → `discordMessageCreateToInboundEvent()` parses the raw payload into a `DiscordInboundEvent` (messageId, channelId, guildId, authorId, authorIsBot, content, attachments, referencedMessageId, threadId).
2. Bot's own messages are skipped (authorId === botUserId).
3. The adapter resolves the session ID: first checks dynamic thread bindings (`resolveThreadSessionId`), then static routes (matching channelId + guildId).
4. The event is converted to an `InternalMessage` via `createInboundMessage()`, with attachments mapped and Discord metadata added to `extensions.platform.discord` (authorId, authorIsBot, isSelf, isOwner).
5. The message is delivered to the agent-to-agent bus, which dispatches to subscribers for that session ID.

### Owner Gate

When `ownerUserId` is configured, only messages with `extensions.platform.discord.isOwner === true` are processed on non-subagent sessions. Subagent sessions bypass this gate.

### Attachments

Inbound attachments are parsed from the Gateway payload with `id`, `url`, `filename`, `contentType`, and `sizeBytes`. They are formatted into a human-readable metadata block for the agent:

```
[message has 2 attachment(s)]
- photo.png (image/png, 1.2 KB)
- doc.pdf (application/pdf, 3.4 MB)
```

---

## Message Routing (Outbound)

`createOutboundSender()` maps session IDs to Discord channel IDs (via static routes or dynamic thread bindings) and sends messages through the REST transport.

- Validates that requested extensions (attachments, threads, replies) are supported by the capability set.
- Supports `message_reference` for reply threading.
- File attachments use `createMessageWithFiles` (multipart/form-data).

### Message Splitting

Discord enforces a 2000-character limit. `splitDiscordMessage()` splits long messages:

- Split priority: newline → space → hard cut.
- Tracks fenced code blocks (triple backticks with language tag): closes at chunk boundary, reopens in next chunk.
- Tracks paired inline formatting markers (`**`, `*`, `__`, `~~`, `||`): closes open markers at chunk end, reopens at next chunk start.

---

## Thread Handling

- **Static threads**: Routes can point to thread channel IDs directly.
- **Dynamic thread bindings**: `registerPlatformThreadBinding(threadChannelId, sessionId)` maps a Discord thread to a subagent session at runtime. Returns an unregister function.
- **Thread creation**: `createThreadFromMessage()` creates a thread from an existing message. Supports `auto_archive_duration` (60, 1440, 4320, or 10080 minutes).
- **Thread deletion**: `deleteChannel()` deletes thread channels.

Inbound messages in threads are routed by checking dynamic bindings first (both `channelId` and `threadId` from the Gateway payload), then falling back to static routes.

---

## Streaming Responses

When `SHOGGOTH_DISCORD_STREAM=1`:

1. A placeholder message (`"…"`) is posted to the channel before the model turn begins.
2. As the model generates output, `setFullContent(text)` edits the placeholder with the current content.
3. On completion, the first chunk replaces the placeholder via `editMessage`; overflow chunks are sent as new messages.
4. Minimum edit interval controlled by `SHOGGOTH_DISCORD_STREAM_MIN_MS` (default 400ms).

The streaming placeholder is posted before the typing indicator starts, because Discord cancels typing when a bot posts a message.

---

## Typing Indicator

The `DiscordPlatformAdapter.withTypingIndicator()` method wraps async work:

1. Fires `POST /channels/{id}/typing` immediately.
2. Renews every 8 seconds (Discord typing lasts ~10s).
3. Clears the renewal interval when work completes.

Only active when the capability set includes `TYPING_NOTIFICATION`.

---

## Slash Commands

Global slash commands are registered on startup via `PUT /applications/{id}/commands`. The registered commands:

| Command    | Description                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/elevate` | Grant or revoke [elevated privileges](daemon.md#elevation). Options: `action` (grant/revoke), `session_id`, `duration`, `grant_id`. |
| `/abort`   | Abort the current session turn. Option: `session_id`.                                                                               |
| `/steer`   | Steer a session with an operator prompt. Options: `prompt` (required), `session_id`, `delivery` (surface/internal).                 |
| `/new`     | Start a new context segment (preserves history).                                                                                    |
| `/reset`   | Reset session context (clears transcript).                                                                                          |
| `/compact` | Compact transcript via [model summarization](models.md#transcript-compaction) (deferred response).                                  |
| `/status`  | Show session status: provider, model, context fill, turns, compactions, queue depth.                                                |
| `/model`   | Get or set the session model selection. Options: `session_id`, `agent_id`, `model_selection`.                                       |
| `/queue`   | Manage the turn queue. Options: `action` (list/remove/clear), `priority`, `index`, `range`, `count`.                                |

When `session_id` is omitted, the handler resolves the session from the channel where the command was invoked.

### Interaction Flow

1. Gateway `INTERACTION_CREATE` → `discordInteractionCreateToEvent()` parses the payload.
2. `discordInteractionToCommand()` extracts the command name and options into a `PlatformCommand`.
3. `translateCommandToControlOp()` maps to a daemon control operation.
4. The handler executes the operation and responds via `interactionCallback` (type 4 = immediate, type 5 = deferred for long operations like `/compact`).

---

## Inline Segment Commands

Users can type these directly in chat (not slash commands):

- `---new` or `---n` — Start a new context segment.
- `---reset` or `---r` — Reset context (clear transcript).

The platform parses these, applies the segment change, sends an acknowledgment message, and runs a startup model turn for the new segment.

---

## Human-in-the-Loop (HITL)

### Notification Channels

HITL notices (pending tool approvals) can be delivered to:

1. **In-session** — Posted as a reply in the same Discord channel where the agent is active (default, disable with `SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0`).
2. **Dedicated channel** — `hitlNotifyChannelId` / `SHOGGOTH_HITL_NOTIFY_CHANNEL_ID`.
3. **DM** — `hitlNotifyDmUserId` / `SHOGGOTH_HITL_NOTIFY_DM_USER_ID` (opens a DM channel via REST, cached).
4. **Webhook** — `hitlNotifyWebhookUrl` / `SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL` (JSON POST with event details).

### Reaction-Based Approval

When a HITL notice is posted, four emoji reactions are added as "buttons":

| Emoji | Action              | Scope                                                                    |
| ----- | ------------------- | ------------------------------------------------------------------------ |
| 1️⃣    | Approve once        | This single pending action only                                          |
| ✅    | Approve for session | All pending + future uses of this tool in this session                   |
| ♾️    | Approve for agent   | All pending + future uses of this tool across all sessions of this agent |
| ❌    | Deny                | Deny this single pending action                                          |

Only the configured `ownerUserId` can trigger these. Bot's own reactions are ignored.

### Notice Registry

`createHitlDiscordNoticeRegistry(maxEntries=2000)` maps `channelId:messageId` → `{ pendingId, sessionId, toolName }`. This allows the reaction handler to resolve which pending action a reaction targets without parsing message content. Entries are evicted FIFO when the cap is reached.

### Reaction Handler Flow

1. Gateway `MESSAGE_REACTION_ADD` fires.
2. `handleDiscordHitlReactionAdd()` checks: is the reactor the owner? Is the message in the registry?
3. `classifyHitlDiscordReaction()` maps the emoji to a kind (once/session/agent/deny).
4. `applyKind()` resolves the pending action in SQLite and optionally enables auto-approve gates for the tool at session or agent scope.

---

## Capabilities

The Discord adapter declares these capabilities:

```
platform: "discord"
supports: markdown, directMessages, groupChannels
extensions:
  attachments, threads, replies, reactionsInbound,
  streamingOutbound, messageEdit, messageDelete,
  threadCreate, threadDelete, messageGet, react,
  reactions, search, attachmentDownload
features: TYPING_NOTIFICATION, SILENT_REPLIES_CHANNEL_AWARE
```

These are exposed to agents via the system prompt so they know what messaging operations are available.

---

## Thinking Display

The `ThinkingDisplayMode` controls how `<thinking>...</thinking>` blocks in model output are rendered:

| Mode        | Behavior                                                     |
| ----------- | ------------------------------------------------------------ |
| `full`      | Thinking shown as Discord blockquote with 💭 prefix per line |
| `indicator` | Single `> 💭 Thinking...` line replaces thinking content     |
| `none`      | Thinking blocks stripped entirely                            |

Applied during both outbound message formatting and streaming edits.

---

## Platform Registration

`discordPlatformRegistration` registers Discord as a messaging platform:

- Platform ID: `discord`
- Resource types: `channel`, `dm`
- URN validation: leaf segment must be a 17–22 digit Discord snowflake.
- Route validation: session URN leaf must match `channelId` when both are snowflakes.
- Default primary session URN uses the reserved UUID (`00000000-0000-0000-0000-000000000000`) unless a channel snowflake is available.

---

## Health Probe

`createDiscordProbe({ getToken })` checks bot token validity via `GET /users/@me`:

- Returns `pass` with bot username/ID on 200.
- Returns `fail` on 401/403 (invalid token) or other errors.
- Returns `skipped` when no token is configured.
- 5-second timeout.

---

## Bootstrap Sequence

`startDaemonDiscordMessaging(opts)` orchestrates startup:

1. Registers the daemon's notice resolver via `setNoticeResolver()`.
2. Checks `isPlatformEnabled(config, "discord")` — returns `undefined` if disabled.
3. Resolves routes from `agents.list.<agentId>.platforms.discord.routes`.
4. Calls `startDiscordMessagingIfConfigured()` which:
   - Validates the bot token exists.
   - Validates routes exist and pass URN policy checks (including agent ID guard).
   - Creates the adapter, agent-to-agent bus, REST transport, and outbound sender.
   - Connects the Gateway.
   - Resolves the bot user ID (from Gateway READY or REST fallback).
5. Registers global slash commands (unless `registerSlashCommands: false`).
6. Returns the `DiscordMessagingRuntime`.

Then `startDiscordPlatform(opts)` wires the runtime into the daemon:

1. Creates session/transcript/tool-run stores, policy engine, HITL stack, MCP runtime.
2. Creates the `DiscordPlatformAdapter` and `PresentationTurnOrchestrator`.
3. Subscribes to the bus for each configured route.
4. Dispatches inbound messages through a per-session chain (serialized, no concurrent turns per session).
5. Returns a `DiscordPlatformHandle` with `runSessionModelTurn`, `subscribeSubagentSession`, `handleReactionPassthrough`, and `stop`.

---

## Turn Queue

Inbound user messages are enqueued in a [tiered turn queue](daemon.md#turn-queue) (`TieredTurnQueue`) with priority `"user"`. System-initiated turns (e.g. from slash commands, session-send, reactions) use priority `"system"`. Turns for the same session are chained sequentially via a per-session promise chain to prevent concurrent model calls.

---

## Error Handling

- All outbound message bodies are truncated to 2000 characters via `sliceDiscordPlatformMessageBody()`.
- Gateway connection failures trigger exponential backoff reconnection (up to 10 attempts).
- REST 429s are retried with rate-limit-aware delays.
- Inbound messages for unknown sessions are logged and dropped.
- Segment command failures send an error reply to the user.
- Turn execution failures are logged; error replies are sent via `adapter.sendError()`.

---

## See Also

- [Daemon](daemon.md) — bootstraps the Discord platform and manages sessions
- [Models](models.md) — model compaction triggered by `/compact` slash command
- [Shared](shared.md) — config schema, session URNs, context levels, platform config helpers
- [CLI](cli.md) — operator CLI alternative to slash commands
