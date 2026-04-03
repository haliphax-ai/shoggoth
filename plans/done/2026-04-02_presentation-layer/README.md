---
date: 2026-04-02
status: complete
completed: 2026-04-03
---

# Presentation Layer — Implementation Plan

## Problem

The Discord platform package (`platform-discord`) currently handles responsibilities beyond its transport boundary:

- **Formatting:** degraded prefix, model tag footer, agent identity prefix, error text formatting, message body slicing
- **Streaming coordination:** coalescing stream setup, interval config, stream failure handling
- **Turn orchestration:** building turn input (MCP context resolution, system prompt assembly), calling `runInboundSessionTurn`
- **Inbound dispatch chain:** `dispatchChained` serializes inbound messages per session; `runDiscordInboundModelTurn` handles turn queue enqueue + fire-and-forget — none of this is Discord-specific
- **HITL notice rendering:** building queued notice lines, reaction wiring, notice registry
- **Error presentation:** `formatDiscordPlatformErrorUserText`, `onTurnExecutionFailed` callback

These concerns are not Discord-specific. A Slack, IRC, or API platform would need the same formatting, streaming, and orchestration logic. The platform should only handle transport, its command surface, and principal mapping.

## Current Architecture

```
Discord Gateway ←→ [platform-discord] ←→ [daemon core]
                    ↑ formatting
                    ↑ streaming
                    ↑ turn orchestration
                    ↑ HITL notice rendering
                    ↑ error presentation
```

## Target Architecture

```
Discord Gateway ←→ [platform-discord] ←→ [presentation] ←→ [daemon core]
                    transport only         formatting
                    slash commands          streaming
                    principal mapping       turn orchestration
                    message splitting       HITL notice rendering
                                           error presentation
```

## Layer Responsibilities

### Platform (transport adapter)
- Inbound message reception and normalization
- Outbound message delivery (text → platform API)
- Platform-specific message splitting (Discord 2000 char limit, etc.)
- Slash command registration and dispatch
- Principal mapping (platform users/channels → internal sessions)
- Platform-specific capabilities (reactions, threads, embeds)
- Typing indicators

### Presentation (new)
- **Reply formatting:** degraded prefix, agent identity prefix, model tag footer
- **Error formatting:** user-facing error text from internal errors
- **Streaming:** coalescing stream setup, interval management, failure fallback
- **Turn orchestration:** MCP lifecycle, building turn input, calling `executeSessionAgentTurn`
- **HITL notice rendering:** building notice text from pending action data
- **Stats formatting:** context fill, queue depth (already partially extracted to `buildFormattedStats`)

### Core (daemon)
- Session management, transcript, stats
- Model invocation and tool loop
- HITL approval gate and pending store
- Policy engine and risk classification
- System prompt assembly
- Turn queue

## Migration Strategy

### Phase 1: Extract presentation module

Create `packages/daemon/src/presentation/` with:

1. `reply-formatter.ts` — `formatDegradedPrefix`, `formatAgentIdentityPrefix`, `formatModelTagFooter`, `formatErrorUserText`
2. `stream-coordinator.ts` — coalescing stream setup, interval config, failure handling
3. `turn-orchestrator.ts` — wraps `runInboundSessionTurn` with MCP lifecycle, turn input building, queue integration
4. `hitl-notice-formatter.ts` — builds notice text from pending action data (platform-agnostic)

### Phase 2: Define platform adapter interface

```ts
interface PlatformAdapter {
  /** Send a text body to the platform. Platform handles splitting, encoding, etc. */
  sendBody(sessionId: string, body: string, opts?: { replyTo?: string }): Promise<void>;
  /** Send an error body to the platform. */
  sendError(sessionId: string, body: string, opts?: { replyTo?: string }): Promise<void>;
  /** Start a streaming session. Returns a handle for pushing updates. */
  startStream?(sessionId: string, opts?: { replyTo?: string }): Promise<StreamHandle>;
  /** Send a HITL notice. Platform decides how to render (embed, plain text, etc.). */
  sendHitlNotice(sessionId: string, notice: HitlNoticeData): Promise<void>;
  /** Platform-specific message size limit. */
  readonly maxBodyLength: number;
  /** Declared capabilities for this platform. */
  readonly capabilities: PlatformCapabilities;
}

interface PlatformCapabilities {
  /** Platform supports adding/removing reactions to messages. */
  reactions?: {
    addReaction(messageId: string, emoji: string): Promise<void>;
    removeReaction(messageId: string, emoji: string): Promise<void>;
  };
  /** Platform supports threading (reply chains, thread containers). */
  threads?: boolean;
  /** Platform supports rich embeds / structured messages. */
  embeds?: boolean;
  /** Platform supports typing indicators. */
  typing?: {
    start(sessionId: string): void;
    stop(sessionId: string): void;
  };
}
```

### Phase 3: Refactor Discord platform

- Remove formatting logic from `platform.ts` → import from presentation
- Remove `runInboundSessionTurn` options assembly → delegate to turn orchestrator
- Platform implements `PlatformAdapter` interface
- Declare capabilities: `reactions`, `threads`, `embeds`, `typing`
- HITL reaction logic moves to presentation (uses `capabilities.reactions` when available); platform just provides the reaction transport

### Phase 4: Fix platform registration inversion

- Rename `platform-discord/src/register.ts` → `platform-discord/src/urn-policy.ts`
- Export `discordUrnPolicy` object only (remove `registerBuiltInMessagingPlatforms` side-effect function)
- Daemon startup registers URN policies by importing policy objects from configured platforms and calling `registerMessagingPlatformUrnPolicy()` for each
- Update all imports that reference the old `register.ts` or `registerBuiltInMessagingPlatforms`

### Phase 5: Wire up

- `startDiscordPlatform` creates a presentation layer instance, passes it the platform adapter
- Inbound messages go: Discord → platform (normalize) → presentation (orchestrate) → core (execute) → presentation (format) → platform (deliver)

## What Stays in Platform

- `slash-commands.ts` — Discord slash command surface (calls control ops, formats responses using presentation helpers)
- `split-message.ts` — Discord 2000-char splitting
- `streaming.ts` — Discord-specific stream handle (webhook edit)
- `hitl/reaction-wiring.ts` — Discord implementation of `capabilities.reactions` (transport for add/remove reaction)
- `gateway-client.ts`, `transport.ts`, `outbound.ts` — pure transport
- `bridge.ts` — platform bridge

## Platform Registration (layer inversion fix)

`register.ts` currently owns `registerBuiltInMessagingPlatforms()`, which creates a hard coupling from daemon core → platform-discord. This is a layer inversion: the daemon must import a specific platform package just to register messaging URN policies.

**Current (wrong):**
```
daemon/src/index.ts → import { registerBuiltInMessagingPlatforms } from "@shoggoth/platform-discord"
                      registerBuiltInMessagingPlatforms()  // side-effect: registers Discord URN policy
```

**Target:**
```
platform-discord exports its URN policy object (data, not a registration function)
daemon discovers configured platforms at startup and registers their policies
```

Changes:
- `platform-discord/src/register.ts` → rename to `urn-policy.ts`, export the `discordUrnPolicy` object only (no registration side-effect)
- `@shoggoth/messaging` keeps `registerMessagingPlatformUrnPolicy()` as the registration API
- Daemon startup iterates configured platforms, imports their URN policy exports, and calls `registerMessagingPlatformUrnPolicy()` for each
- Future platforms (Slack, IRC, API) follow the same pattern: export a policy object, daemon registers it

## What Moves to Presentation

| Current Location | New Location |
|---|---|
| `platform.ts: formatDiscordPlatformDegradedPrefix` | `presentation/reply-formatter.ts: formatDegradedPrefix` |
| `platform.ts: formatDiscordPlatformModelTagFooter` | `presentation/reply-formatter.ts: formatModelTagFooter` |
| `platform.ts: formatAgentIdentityPrefix` (imported) | `presentation/reply-formatter.ts` |
| `errors.ts: formatDiscordPlatformErrorUserText` | `presentation/reply-formatter.ts: formatErrorUserText` |
| `errors.ts: sliceDiscordPlatformMessageBody` | stays in platform (transport concern: message size limit) |
| `platform.ts: runInboundSessionTurn options` | `presentation/turn-orchestrator.ts` |
| `platform.ts: dispatchChained + runDiscordInboundModelTurn` | `presentation/turn-orchestrator.ts` (inbound dispatch chain + turn queue enqueue) |
| `hitl/notifier.ts: buildHitlQueuedNoticeLines` | `presentation/hitl-notice-formatter.ts` |
| `notices.ts: daemonNotice` | `presentation/notices.ts` (notice template registry) |

## Files to Create/Modify

1. **NEW** `packages/daemon/src/presentation/reply-formatter.ts`
2. **NEW** `packages/daemon/src/presentation/stream-coordinator.ts`
3. **NEW** `packages/daemon/src/presentation/turn-orchestrator.ts`
4. **NEW** `packages/daemon/src/presentation/hitl-notice-formatter.ts`
5. **NEW** `packages/daemon/src/presentation/notices.ts`
6. **NEW** `packages/daemon/src/presentation/platform-adapter.ts` (interface)
7. **NEW** `packages/daemon/src/presentation/index.ts`
8. `packages/platform-discord/src/platform.ts` — thin adapter, delegates to presentation
9. `packages/platform-discord/src/errors.ts` — remove formatting, keep slicing
10. `packages/platform-discord/src/notices.ts` — move templates to presentation
11. `packages/platform-discord/src/hitl/notifier.ts` — use presentation formatter
12. `packages/platform-discord/src/register.ts` — rename to `urn-policy.ts`, export policy object only, remove registration side-effect
13. `packages/daemon/src/index.ts` — daemon-driven platform URN policy registration at startup
14. `packages/daemon/src/messaging/inbound-session-turn.ts` — simplify interface (presentation handles options assembly)
15. Tests for presentation layer (formatting, orchestration)

## Notes

- This is a refactor, not a feature. No user-visible behavior changes.
- The `PlatformAdapter` interface enables future platforms (Slack, IRC, API) without duplicating formatting/orchestration.
- `daemonNotice` template strings should move to presentation since they're not platform-specific.
- Slash command response formatting can use presentation helpers but stays in the platform (it's part of the command surface).
- Message splitting stays in platform — it's a transport constraint, not a presentation concern.
