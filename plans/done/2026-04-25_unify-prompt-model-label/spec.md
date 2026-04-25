# Specification: Unify Prompt Model Label

## Interface Changes

### `shoggoth/packages/daemon/src/sessions/session-system-prompt.ts`

**Modified Interface:** `BuildSessionSystemContextInput`

```typescript
export interface BuildSessionSystemContextInput {
  // ... existing fields ...
  /** The pre-resolved model label (e.g., 'gemini-flash-latest (provider: google)'). Required. */
  readonly modelLabel: string;
  /** Delivery surface id from the session URN. Required. */
  readonly channel: string;
}
```

**Modified Function:** `buildSessionSystemContext`

- Remove internal call to `formatPrimaryModelLabel`.
- Remove `formatPrimaryModelLabel` function (logic moves to caller).

### `shoggoth/packages/daemon/src/sessions/session-agent-turn.ts`

**Modified Interface:** `ExecuteSessionAgentTurnInput`

```typescript
export interface ExecuteSessionAgentTurnInput {
  // ...
  // REMOVE: readonly systemPrompt: string;
  // ADD:
  /** Context level for system prompt assembly. */
  readonly contextLevel?: ContextLevel;
  /** Internal context segment UUID. */
  readonly contextSegmentId?: string;
}
```

## Logic Changes

### 1. Model Resolution in `executeSessionAgentTurn`

The function already resolves `effectiveModel`. It will now use this to call `formatPrimaryModelLabel`-like logic and then call `buildSessionSystemContext` internally.

### 2. Prompt Assembly Lifecycle

- Turn enters `executeSessionAgentTurn`.
- Models are resolved (`effectiveModel`).
- System context (prompt) is built using the active model label.
- Model is invoked with the freshly built system prompt.

## Test Contracts

- **Unit Test:** `session-system-prompt.test.ts` must verify that the provided `modelLabel` appears verbatim in the `Runtime:` section.
- **Integration Test:** `session-agent-turn.test.ts` must verify that when a `modelSelection` override is present, the generated system prompt contains that model's label.
