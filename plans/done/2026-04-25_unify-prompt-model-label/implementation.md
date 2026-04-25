# Implementation Phases: Unify Prompt Model Label

## Phase 1: Refactor `buildSessionSystemContext` (TDD)

- **Red:** Update `shoggoth/packages/daemon/test/sessions/session-system-prompt.test.ts` to require a `modelLabel` in the input and assert it appears in the output. Tests will fail to compile/run.
- **Green:**
  - Modify `BuildSessionSystemContextInput` to require `modelLabel` and `channel`.
  - Update `buildSessionSystemContext` to use these inputs directly.
  - Remove `formatPrimaryModelLabel` from `session-system-prompt.ts`.
- **Files:**
  - `shoggoth/packages/daemon/src/sessions/session-system-prompt.ts`
  - `shoggoth/packages/daemon/test/sessions/session-system-prompt.test.ts`

## Phase 2: Refactor Turn Execution Input (TDD)

- **Red:** Update `shoggoth/packages/daemon/test/sessions/session-agent-turn.test.ts` to remove `systemPrompt` from the turn input and instead verify that the internal assembly correctly labels the model.
- **Green:**
  - Update `ExecuteSessionAgentTurnInput` to remove `systemPrompt`.
  - Implement prompt assembly logic inside `executeSessionAgentTurn` using the resolved `effectiveModel`.
  - Update `runInboundSessionTurn` and platform callers to stop providing the prompt string.
- **Files:**
  - `shoggoth/packages/daemon/src/sessions/session-agent-turn.ts`
  - `shoggoth/packages/daemon/src/messaging/inbound-session-turn.ts`
  - `shoggoth/packages/platform-discord/src/platform.ts`

## Phase 3: Cleanup and Verification

- Update any scripts or remaining tests (like `preview-context.ts`) that call the prompt builder.
- Perform a final verification using a subagent spawn to confirm the `Runtime:` label matches Gemma 4.
- **Files:**
  - `shoggoth/scripts/preview-context.ts`
  - `shoggoth/packages/daemon/test/system-context-spoofing.test.ts`
