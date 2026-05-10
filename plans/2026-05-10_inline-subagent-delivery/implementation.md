# Implementation

## Phase 1: Inline Injection via Steer Channel

Modify `deliverSubagentResult()` to attempt inline delivery before falling back to the queued-turn path. This is the minimal change that covers both background one-shot and non-thread-bound persistent subagents.

- Add `pushSteer` import from `../sessions/steer-channel`
- Insert `pushSteer(respondTo, content)` check before the existing `runSessionModelTurn` call
- Return early on success with an info log

**Files:**

- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/test/control/integration-ops.test.ts` (new or extended)

## Phase 2: Dedicated Channel with Distinct Framing (optional follow-up)

If testing reveals the model confuses operator steers with subagent results, introduce a parallel injection channel with distinct message framing.

- Add `pushSubagentResult()` / `drainSubagentResults()` to steer-channel.ts (or a new file)
- Drain subagent results in tool-loop.ts alongside steers
- Add `pushSubagentResultMessage(content)` to the model client with appropriate framing (e.g., system-context prefix or structured markers)
- Update `deliverSubagentResult()` to use the new channel instead of `pushSteer()`

**Files:**

- `packages/daemon/src/sessions/steer-channel.ts`
- `packages/daemon/src/sessions/tool-loop.ts`
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts`
- `packages/daemon/src/control/integration-ops.ts`
