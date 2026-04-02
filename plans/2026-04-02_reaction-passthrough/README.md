# Reaction Passthrough — Implementation Plan

## Overview

Allow operator reactions on agent messages to flow back through the transport layer as agent input. Two tiers:

1. **Global reactions** — a configured set of emoji (default: 👍 👎 ✅ ❌) that always flow through on any agent message
2. **Ad-hoc reactions** — agent embeds a standardized reaction legend in a message; operator picks an option via reaction

Both trigger a **minimal context turn** — a general-purpose lightweight turn mode that sends reduced transcript context to save tokens.

## Design Principles

- **Stateless** — no registry of "messages awaiting reactions." The message body is the source of truth. At reaction time, the transport reads the current message content, checks for a legend, and routes accordingly.
- **Global/ad-hoc isolation** — if a message has a reaction legend and the reaction matches a legend entry, it's ad-hoc. Global semantics do not apply. If there's no legend (or the reaction doesn't match), fall through to global passthrough check.
- **Minimal context turns** — a system-wide capability, not reaction-specific. Heartbeats, cron, and other lightweight triggers can also use minimal context mode.

## Reaction Routing Flow

```
Operator reacts to a bot message
  │
  ├─ Message is currently streaming/splitting?
  │   └─ Queue the reaction; process after response completes
  │
  ├─ Message too old (age > threshold)?
  │   └─ Discard; post warning to channel ("⚠️ Reaction ignored — message too old")
  │
  ├─ Message body contains a reaction legend?
  │   ├─ Reaction matches a legend entry?
  │   │   └─ Ad-hoc reaction turn (legend context + reaction + message content)
  │   └─ Reaction does NOT match any legend entry?
  │       └─ Discard (not a valid choice; do NOT fall through to global)
  │
  └─ No legend in message body?
      ├─ Reaction is in global passthrough set?
      │   └─ Global reaction turn (reaction + message content)
      └─ Reaction is NOT in global set?
          └─ Discard (ignored)
```

Note: when a message has a legend, reactions that don't match any legend entry are discarded entirely — they do NOT fall through to global. This prevents semantic collision (e.g., 👍 meaning "approve globally" when the agent intended it as "Option A" in an ad-hoc choice).

## Minimal Context Turns

A new turn mode available system-wide, not just for reactions.

**What changes:**
- System prompt is included (always needed)
- System context buffer is drained (describes why this turn is happening)
- Transcript is truncated to last N messages (configurable, default 0 or small number)
- The triggering event context is injected (reaction details, heartbeat signal, cron job info, etc.)

**Who can use it:**
- Reaction passthrough (global and ad-hoc)
- Heartbeat turns (currently send full transcript — wasteful)
- Cron job turns (same)
- Any future lightweight trigger

**Config:**
```json
{
  "runtime": {
    "minimalContext": {
      "transcriptTailMessages": 2
    }
  }
}
```

## Global Reactions

**Config (global and per-agent):**
```json
{
  "reactions": {
    "globalPassthrough": ["👍", "👎", "✅", "❌"],
    "maxAgeMinutes": 30
  }
}
```

Per-agent override:
```json
{
  "agents": {
    "list": {
      "main": {
        "reactions": {
          "globalPassthrough": ["👍", "👎", "✅", "❌", "🔄"],
          "maxAgeMinutes": 60
        }
      }
    }
  }
}
```

**Turn context injected:**
```
Operator reacted 👍 to your message: "<truncated message content>"
```

## Ad-Hoc Reaction Legends

### Legend Format

Standardized block in the agent's message body, parseable by the transport layer and readable by the user:

```
React to choose:
1️⃣ Refactor the module first
2️⃣ Ship as-is with a TODO
3️⃣ Split into two PRs
```

**Parsing rules:**
- Block starts with a line matching `React to choose:` (case-insensitive)
- Each subsequent line is `<emoji> <label>` until a blank line or end of message
- Emoji is the first token (single emoji or emoji sequence)
- Label is the rest of the line (trimmed)

### Turn context injected:

```
Operator reacted 2️⃣ to your message with reaction legend:
1️⃣ Refactor the module first
2️⃣ Ship as-is with a TODO ← selected
3️⃣ Split into two PRs

Original message: "<truncated message content>"
```

The agent sees the full legend, which option was selected, and the original message for context.

## Streaming/Split Message Queuing

When the agent is actively streaming or splitting a response into multiple messages:

- The presentation layer tracks all message IDs belonging to the current response
- The presentation layer knows when the response is complete (stream finalized, all chunks sent)
- Any reaction to any of those message IDs is queued until the response is complete
- On completion, queued reactions are processed against the final message content
- On stream failure/timeout, queued reactions are discarded

This is lightweight — just a `Map<messageId, QueuedReaction[]>` in the presentation layer, drained on response completion.

## Integration Points

### Transport Layer (platform adapter)
- Receives reaction events from the platform (Discord `MESSAGE_REACTION_ADD`, etc.)
- Checks if the message is from the bot
- Fetches current message content (for legend parsing)
- Checks message age against threshold
- Passes reaction + message content to the presentation layer

### Presentation Layer
- Parses reaction legends from message content
- Determines routing: ad-hoc legend match → ad-hoc turn, no legend + global match → global turn, otherwise discard
- Manages streaming reaction queue
- Assembles minimal context turn input
- Triggers the turn via the core

### Core (daemon)
- Executes the minimal context turn (system prompt + buffer + truncated transcript + event context)
- No awareness of reactions specifically — just receives a turn with minimal context and event context

## Files to Create/Modify

1. **NEW** `packages/daemon/src/presentation/reaction-router.ts` — legend parsing, global/ad-hoc routing, age check
2. **NEW** `packages/daemon/src/presentation/minimal-context.ts` — minimal context turn builder (system prompt + buffer + tail messages + event context)
3. **NEW** `packages/daemon/src/presentation/reaction-queue.ts` — streaming reaction queue (Map + drain on completion)
4. `packages/platform-discord/src/platform.ts` — subscribe to `MESSAGE_REACTION_ADD`, pass to presentation
5. `packages/daemon/src/sessions/session-agent-turn.ts` — support minimal context mode (truncated transcript)
6. `packages/daemon/src/sessions/session-system-prompt.ts` — inject reaction event context via system context buffer
7. Config schema update for `reactions.globalPassthrough`, `reactions.maxAgeMinutes`, `runtime.minimalContext.transcriptTailMessages`
8. Tests for legend parsing, routing logic, age threshold, streaming queue, minimal context assembly

## Edge Cases

- **Multiple reactions on same message:** each reaction is processed independently (could trigger multiple turns — the turn queue serializes them)
- **Operator removes a reaction:** ignored (only adds are processed)
- **Bot reacts to its own message:** ignored (only operator reactions)
- **Legend in a split chunk that isn't the last one:** works fine — legend check is per-message, and the legend could be in any chunk
- **Agent edits a message after sending:** legend check reads current content at reaction time, so edits are respected
