# Specification

## Interfaces

### New: `SubagentDeliveryMode`

```ts
/** Controls how subagent turn results are delivered to the parent session. */
type SubagentDeliveryMode = "inline" | "queue" | "drop";
```

### Modified: Session Store Row

```ts
// session-store.ts — add delivery_mode and respond_to to the subagent metadata
interface SessionRow {
  // ... existing fields ...
  subagentDeliveryMode: SubagentDeliveryMode | null;
  subagentRespondTo: string | null; // persisted for all-turn delivery lookup
}
```

### Existing Interfaces (unchanged)

```ts
// steer-channel.ts — reused as-is
function pushSteer(sessionId: string, message: string): boolean;
function drainSteers(sessionId: string): string[];
```

## API / Function Signatures

### Modified: `deliverSubagentResult` (integration-ops.ts)

```ts
/**
 * Deliver a subagent's completed turn result to the respond_to session.
 * Respects delivery_mode: inline attempts steer injection first, queue always
 * enqueues a new turn, drop does nothing.
 * Truncates result text to maxChars (default 8000).
 */
async function deliverSubagentResult(
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>,
  opts: {
    childSessionId: string;
    respondTo: string;
    internalDelivery: boolean;
    mode: "one_shot" | "persistent";
    deliveryMode: SubagentDeliveryMode;
    assistantText: string;
    subLog: ReturnType<typeof getLogger>;
    maxChars?: number; // default 8000
  },
): Promise<void>;
```

### Modified: Foreground One-Shot Return Shape

When `delivery_mode` is `queue` or `drop`, the foreground one-shot spawn still blocks until the child completes but returns only session metadata (no `reply` field):

```ts
// delivery_mode = "inline" (default) — current behavior
return {
  session_id: childId,
  mode: "one_shot",
  reply: turn.latestAssistantText, // included
  respond_to: respondTo,
  internal: internalDelivery,
  failover: turn.failoverMeta ?? null,
};

// delivery_mode = "queue" — block, deliver as queued turn, return metadata
return {
  session_id: childId,
  mode: "one_shot",
  delivery_mode: "queue",
  respond_to: respondTo,
  internal: internalDelivery,
};

// delivery_mode = "drop" — block, discard result, return metadata
return {
  session_id: childId,
  mode: "one_shot",
  delivery_mode: "drop",
  respond_to: respondTo,
  internal: internalDelivery,
};
```

### Modified: Tool Descriptor (builtin-shoggoth-tools.ts)

```ts
// Add to subagentToolArgs.properties:
delivery_mode: {
  type: "string",
  enum: ["inline", "queue", "drop"],
  description:
    "spawn_one_shot, spawn_persistent: how the subagent's completed result is delivered to the parent. " +
    "'inline' (default) injects into the parent's active tool loop (foreground one-shot returns as tool result); " +
    "falls back to 'queue' if no active loop. " +
    "'queue' always delivers as a new turn. " +
    "'drop' does not deliver; use 'result' action to retrieve manually.",
},
```

### Modified: CLI (run-subagent.ts)

```
shoggoth subagent spawn [--model-options <json>] [--delivery-mode inline|queue|drop] one_shot <parentUrn|agentId> <prompt...>
shoggoth subagent spawn [--model-options <json>] [--delivery-mode inline|queue|drop] persistent <parentUrn|agentId> [threadId] <prompt...>
```

### Modified: Session Handler (session-handlers.ts)

```ts
// In spawn_one_shot and spawn_persistent action blocks:
const deliveryMode = args.delivery_mode;
if (deliveryMode === "inline" || deliveryMode === "queue" || deliveryMode === "drop") {
  payload.delivery_mode = deliveryMode;
}
```

### Modified: Control Plane Op (integration-ops.ts)

```ts
// In subagent_spawn case, read delivery_mode from payload:
const deliveryModeRaw = pl.delivery_mode;
const deliveryMode: SubagentDeliveryMode =
  deliveryModeRaw === "queue" || deliveryModeRaw === "drop" ? deliveryModeRaw : "inline";

// Store on session row for persistent all-turn delivery:
sessions.update(childId, {
  parentSessionId,
  subagentMode: mode,
  subagentDeliveryMode: deliveryMode,
  subagentRespondTo: respondTo,
  // ... other fields
});
```

## Data Structures / Schemas

### Session Store Schema Change

```sql
-- Add columns to sessions table (or equivalent in-memory store)
ALTER TABLE sessions ADD COLUMN subagent_delivery_mode TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN subagent_respond_to TEXT DEFAULT NULL;
```

These columns store the delivery preferences so that subsequent persistent subagent turns can look up how to deliver results without the spawn payload being available.

### System Context Envelope Format

```
--- BEGIN TRUSTED SYSTEM CONTEXT [token:<session_token>] ---
[subagent.result]
Result delivered from subagent <childSessionId>.

{
  "child_session_id": "<childSessionId>",
  "mode": "one_shot" | "persistent"
}
--- END TRUSTED SYSTEM CONTEXT [token:<session_token>] ---

[Subagent completed] session_id: <childSessionId>

<assistantText>
```

## Code Examples

### Modified `deliverSubagentResult`

```ts
import { pushSteer } from "../sessions/steer-channel";

const DEFAULT_MAX_CHARS = 8000;

async function deliverSubagentResult(
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>,
  opts: {
    childSessionId: string;
    respondTo: string;
    internalDelivery: boolean;
    mode: "one_shot" | "persistent";
    deliveryMode: SubagentDeliveryMode;
    assistantText: string;
    subLog: ReturnType<typeof getLogger>;
    maxChars?: number;
  },
): Promise<void> {
  const {
    childSessionId,
    respondTo,
    internalDelivery,
    mode,
    deliveryMode,
    assistantText,
    subLog,
    maxChars = DEFAULT_MAX_CHARS,
  } = opts;

  // drop mode: do nothing
  if (deliveryMode === "drop") {
    subLog.info("subagent result delivery skipped (drop mode)", {
      childSessionId,
      respondTo,
      mode,
    });
    return;
  }

  const truncatedText =
    assistantText.length > maxChars ? assistantText.slice(0, maxChars) : assistantText;
  const content = `[Subagent completed] session_id: ${childSessionId}\n\n${truncatedText}`;

  // inline mode: attempt steer injection first
  if (deliveryMode === "inline" && pushSteer(respondTo, content)) {
    subLog.info("subagent result injected inline via steer channel", {
      childSessionId,
      respondTo,
      mode,
      internal: internalDelivery,
    });
    return;
  }

  // queue mode (or inline fallback): enqueue a new model turn
  try {
    await ext.runSessionModelTurn({
      sessionId: respondTo,
      userContent: content,
      userMetadata: {
        subagent_result: true,
        child_session_id: childSessionId,
        mode,
      },
      systemContext: {
        kind: "subagent.result",
        summary: `Result delivered from subagent ${childSessionId}.`,
        data: { child_session_id: childSessionId, mode },
      },
      delivery: { kind: "internal" },
    });
    subLog.info("subagent result delivered to respond_to session", {
      childSessionId,
      respondTo,
      mode,
      internal: internalDelivery,
    });
  } catch (err) {
    subLog.warn("failed to deliver subagent result to respond_to session", {
      childSessionId,
      respondTo,
      mode,
      error: String(err),
    });
  }
}
```

### Foreground One-Shot with delivery_mode

```ts
// In the foreground one-shot path:
if (modeRaw === "one_shot" && !backgroundSpawn) {
  const turn = await ext.runSessionModelTurn({
    /* ... */
  });

  if (deliveryMode === "inline") {
    // Current behavior: return reply in tool call result
    return {
      session_id: childId,
      mode: "one_shot",
      reply: turn.latestAssistantText,
      respond_to: respondTo,
      internal: internalDelivery,
      failover: turn.failoverMeta ?? null,
    };
  }

  // queue or drop: deliver via deliverSubagentResult, return metadata only
  await deliverSubagentResult(ext, {
    childSessionId: childId,
    respondTo,
    internalDelivery,
    mode: "one_shot",
    deliveryMode,
    assistantText: turn.latestAssistantText,
    subLog,
  });

  return {
    session_id: childId,
    mode: "one_shot",
    delivery_mode: deliveryMode,
    respond_to: respondTo,
    internal: internalDelivery,
  };
}
```

### All-Turn Delivery Hook for Persistent Subagents

```ts
// After each persistent subagent turn completes:
const row = sessions.getById(childSessionId);
if (
  row?.subagentMode === "persistent" &&
  !row.subagentPlatformThreadId &&
  row.subagentDeliveryMode !== "drop" &&
  row.subagentRespondTo
) {
  await deliverSubagentResult(ext, {
    childSessionId,
    respondTo: row.subagentRespondTo,
    internalDelivery: true,
    mode: "persistent",
    deliveryMode: row.subagentDeliveryMode ?? "inline",
    assistantText: turn.latestAssistantText,
    subLog,
  });
}
```
