---
date: 2026-04-08
completed: 2026-04-08
---

# Direct Steer Injection Into Active Tool Loops

## Problem

`session_steer` calls `runSessionModelTurn` which enqueues into the turn queue. The turn queue serializes turns, so if a tool loop is already running, the steer message blocks until the loop finishes. Steering can never reach an agent mid-tool-loop.

## Design

### 1. Steer Channel (`steer-channel.ts`)

A simple async queue that maps session IDs to pending steer messages. The tool loop registers/unregisters on entry/exit. Between tool calls, the loop drains pending steers and injects them as system messages via `model.pushToolMessage` (as a synthetic tool message won't work — use direct message array injection, or push as a system-role message).

Since `ModelClient` only exposes `pushToolMessage`, and the `SessionToolLoopModelClient` owns the `messages` array, we'll add a `pushSystemMessage` method to `ModelClient` for injecting steer content as a user-role message (the model sees it as operator guidance).

Actually — looking at the model client, the simplest approach: add an optional `pushSteerMessage?(content: string): void` to `ModelClient`. The `SessionToolLoopModelClient` implements it by pushing a `{ role: "user", content }` message. The tool loop calls it for each drained steer.

### 2. Steer Channel Registry (`steer-channel.ts`)

Follows the same singleton pattern as `system-context-buffer.ts` and `session-turn-abort.ts`:
- `registerSteerChannel(sessionId): { push, unregister }`
- `pushSteer(sessionId, message): boolean` — returns true if channel exists
- `drainSteers(sessionId): string[]`

### 3. Split Path in `session_steer` (`integration-ops.ts`)

Before calling `ext.runSessionModelTurn`, check `pushSteer(sessionId, prompt)`. If it returns true (active loop), return `{ injected: true }`. Otherwise fall through to existing `runSessionModelTurn` path.

## Phases

### Phase 1: Steer channel + registry + tests
Files: `packages/daemon/src/sessions/steer-channel.ts`, `packages/daemon/test/sessions/steer-channel.test.ts`

### Phase 2: Tool loop integration + tests
Files: `packages/daemon/src/sessions/tool-loop.ts`, `packages/daemon/src/sessions/session-tool-loop-model-client.ts`, `packages/daemon/test/sessions/tool-loop-steer.test.ts`

### Phase 3: integration-ops split path + tests
Files: `packages/daemon/src/control/integration-ops.ts`, `packages/daemon/test/control/integration-ops-steer.test.ts`
