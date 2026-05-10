# Specification

## Interfaces

No new interfaces are introduced. The change modifies the internal behavior of an existing function.

### Existing Interfaces (unchanged)

```ts
// steer-channel.ts — already exists, reused as-is
function pushSteer(sessionId: string, message: string): boolean;
function drainSteers(sessionId: string): string[];
```

```ts
// session-tool-loop-model-client.ts — already exists
interface ToolLoopModelClient {
  pushSteerMessage(content: string): void;
  // ...
}
```

## API / Function Signatures

### Modified: `deliverSubagentResult` (integration-ops.ts)

```ts
/**
 * Deliver a subagent's completed result to the respond_to session.
 * Attempts inline injection via the steer channel first. Falls back to
 * queuing a new model turn if the parent session has no active tool loop.
 */
async function deliverSubagentResult(
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>,
  opts: {
    childSessionId: string;
    respondTo: string;
    internalDelivery: boolean;
    mode: "one_shot" | "persistent";
    assistantText: string;
    subLog: ReturnType<typeof getLogger>;
  },
): Promise<void>;
```

The signature is unchanged. Only the internal behavior changes.

## Data Structures / Schemas

No new data structures. The message content format remains:

```
[Subagent completed] session_id: <childSessionId>

<assistantText>
```

This format is used for both the inline (steer) path and the fallback (queued turn) path.

## Code Examples

### Modified `deliverSubagentResult`

```ts
import { pushSteer } from "../sessions/steer-channel";

async function deliverSubagentResult(
  ext: NonNullable<typeof subagentRuntimeExtensionRef.current>,
  opts: {
    childSessionId: string;
    respondTo: string;
    internalDelivery: boolean;
    mode: "one_shot" | "persistent";
    assistantText: string;
    subLog: ReturnType<typeof getLogger>;
  },
): Promise<void> {
  const { childSessionId, respondTo, internalDelivery, mode, assistantText, subLog } = opts;
  const content = `[Subagent completed] session_id: ${childSessionId}\n\n${assistantText}`;

  // Attempt inline injection into parent's active tool loop
  if (pushSteer(respondTo, content)) {
    subLog.info("subagent result injected inline via steer channel", {
      childSessionId,
      respondTo,
      mode,
      internal: internalDelivery,
    });
    return;
  }

  // Fallback: parent turn is not active, queue a new model turn
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
        data: {
          child_session_id: childSessionId,
          mode,
        },
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
