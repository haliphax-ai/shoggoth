# Implementation

## Phase 1: OOB Response Schemas + `modelInvocationOverride` Threading

Define the schema objects and thread the `modelInvocationOverride` parameter through the call chain. This phase is purely additive — no existing behavior changes.

- Create `packages/daemon/src/messaging/oob-response-schemas.ts` with `OOB_SCHEMA_WITH_SENDER`, `OOB_SCHEMA_NO_SENDER`, `OOB_WITH_SENDER_GUIDANCE`, and `OOB_NO_SENDER_GUIDANCE` constants (~30 lines)
- Add `modelInvocationOverride?: Partial<ModelInvocationParams>` to the `runSessionModelTurn` input type in `packages/daemon/src/subagent/subagent-extension-ref.ts` (~3 lines)
- Add `modelInvocationOverride?: Partial<ModelInvocationParams>` to `ExecuteSessionAgentTurnInput` in `packages/daemon/src/sessions/session-agent-turn.ts` (~3 lines)
- In `executeSessionAgentTurn`, merge `modelInvocationOverride` into the session's model invocation params before creating the model client (~7 lines)
- Thread `modelInvocationOverride` through `runSessionModelTurn` in `packages/daemon/src/index.ts` — pass it from the input to `executeSessionAgentTurn` (~5 lines)

**Files:**

- `packages/daemon/src/messaging/oob-response-schemas.ts` (new)
- `packages/daemon/src/subagent/subagent-extension-ref.ts`
- `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/src/index.ts`

## Phase 2: `deliverOobStructuredResponse()` + Modify `deliverSubagentResult()`

Add the delivery function and switch the subagent result queue path to use structured output. This is the core behavioral change for subagent results.

- Implement `deliverOobStructuredResponse()` in `packages/daemon/src/control/integration-ops.ts` (~50 lines). It parses the structured JSON, posts `to_operator` via `ext.postToOperator()`, and delivers `to_sender` via `pushSteer()` or `runSessionModelTurn()`
- Add `postToOperator` to `SubagentRuntimeExtension` type in `packages/daemon/src/subagent/subagent-extension-ref.ts` (~3 lines)
- Wire `postToOperator` in `packages/platform-discord/src/plugin.ts` — call `deliveryRegistry.resolveOperatorDelivery()` and `adapter.sendBody()` (~10 lines)
- Modify `deliverSubagentResult()` queue/fallback path in `packages/daemon/src/control/integration-ops.ts`:
  - Replace `asyncContent` (with reminders) with `baseContent` (clean) + `OOB_WITH_SENDER_GUIDANCE`
  - Add `modelInvocationOverride: { responseSchema: OOB_SCHEMA_WITH_SENDER, structuredOutputMode: "best-effort" }` to the `runSessionModelTurn` call
  - After the turn, call `deliverOobStructuredResponse()` instead of relying on the platform's delivery (~20 lines changed)
- Keep the inline/steer path unchanged — it already works correctly

**Files:**

- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/src/subagent/subagent-extension-ref.ts`
- `packages/platform-discord/src/plugin.ts`

## Phase 3: Timer Handler Modification

Switch timer fires from the `NO_REPLY` sentinel pattern to structured output.

- In `packages/daemon/src/index.ts` timer fire handler (~line 570-586):
  - Replace the `guidance` string with `OOB_NO_SENDER_GUIDANCE`
  - Add `modelInvocationOverride: { responseSchema: OOB_SCHEMA_NO_SENDER, structuredOutputMode: "best-effort" }` to the `runSessionModelTurn` call
  - After the turn, call `deliverOobStructuredResponse()` with `hasSender: false`
- Remove the `NO_REPLY` sentinel check if one exists in the platform's `runSessionModelTurn` (the structured output approach replaces it)

**Files:**

- `packages/daemon/src/index.ts`

## Phase 4: Context Hint Updates

Clean up the old context hint strings that reference `builtin-message action=post` and `NO_REPLY`.

- In `packages/daemon/src/control/integration-ops.ts`:
  - Remove or update `baseReminder` and `asyncOnlyReminder` constants (~line 378-386)
  - The steer path still uses `baseReminder` — keep it but update the text to reflect that the reply goes to the subagent only
  - The queue path no longer appends reminders (uses `OOB_WITH_SENDER_GUIDANCE` instead)
- In `packages/daemon/src/index.ts`:
  - Remove the old timer `guidance` string that mentions `NO_REPLY` and `builtin-message`
- In `packages/daemon/src/messaging/inbound-session-turn.ts`:
  - Thread `modelInvocationOverride` through the persistent subagent all-turn delivery path (~5 lines)

**Files:**

- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/src/index.ts`
- `packages/daemon/src/messaging/inbound-session-turn.ts`

## Phase 5: Tests

Add tests for the new structured output delivery path and update existing tests for changed behavior.

- New test file: `packages/daemon/test/messaging/oob-response-schemas.test.ts` — verify schema structure, required fields, JSON Schema validity
- New test file: `packages/daemon/test/control/deliver-oob-structured-response.test.ts`:
  - Parse valid response with both fields → both delivered
  - Parse valid response with null `to_operator` → only sender delivered
  - Parse valid response with null `to_sender` → only operator delivered
  - Parse valid response with both null → nothing delivered
  - Parse invalid JSON → warning logged, nothing delivered
  - Truncation of long messages
- Update `packages/daemon/test/control/deliver-subagent-result.test.ts`:
  - Queue-mode tests should verify `modelInvocationOverride` is set with `OOB_SCHEMA_WITH_SENDER`
  - Update reminder text assertions (old `asyncOnlyReminder` no longer appended)
  - Add test: structured response with `to_operator` → posted to messaging surface
  - Add test: structured response with `to_sender` → delivered to subagent
- Update `packages/daemon/test/sessions/persistent-subagent-delivery.test.ts`:
  - Queue-mode persistent subagent test should verify structured output path
- New test: `packages/daemon/test/sessions/model-invocation-override.test.ts`:
  - Verify `modelInvocationOverride` merges into session model invocation params
  - Verify override fields take precedence
  - Verify no override → existing behavior unchanged

**Files:**

- `packages/daemon/test/messaging/oob-response-schemas.test.ts` (new)
- `packages/daemon/test/control/deliver-oob-structured-response.test.ts` (new)
- `packages/daemon/test/control/deliver-subagent-result.test.ts` (update)
- `packages/daemon/test/sessions/persistent-subagent-delivery.test.ts` (update)
- `packages/daemon/test/sessions/model-invocation-override.test.ts` (new)

## Phase 6: Documentation

Update user-facing and developer documentation to reflect the new delivery behavior.

- Update `docs/tools/builtin-session.md` — document that subagent results are now auto-delivered via structured output; agents no longer need to call `builtin-message action=post`
- Update `docs/tools/builtin-timer.md` — document that timer fires can now surface findings to the operator via structured output
- Add a brief note to the structured output documentation referencing OOB delivery as a use case

**Files:**

- `docs/tools/builtin-session.md`
- `docs/tools/builtin-timer.md`
- `docs/models/structured-output.md` (if it exists)
