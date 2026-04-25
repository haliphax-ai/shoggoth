---
date: 2026-04-25
completed: 2026-04-25
---

# Unify System Prompt Model Label

Currently, the `buildSessionSystemContext` function (responsible for assembling the agent's system prompt) uses its own internal model resolution logic to generate the `model=` field in the `Runtime:` context section. This logic is inconsistent with the actual model resolution performed during turn execution, especially for subagents where top-level configuration overrides are used.

Furthermore, system prompt assembly is currently triggered by the platform layer, which is not a platform concern.

This plan aims to move system prompt assembly into the core turn logic and ensure the `Runtime:` metadata matches the actual model being invoked.

## Architecture

- **`shoggoth/packages/daemon/src/sessions/session-system-prompt.ts`**: Refactor `buildSessionSystemContext` to accept a pre-resolved `modelLabel` and remove internal resolution logic.
- **`shoggoth/packages/daemon/src/sessions/session-agent-turn.ts`**: Move the call to `buildSessionSystemContext` into `executeSessionAgentTurn` so it can use the resolved `effectiveModel`.
- **`shoggoth/packages/platform-discord/src/platform.ts`**: Remove prompt assembly responsibility and instead pass platform capabilities to the turn executor.

## Decisions

- **Unify Truth:** The turn executor (`executeSessionAgentTurn`) is the only source of truth for which model is actually being called (after overrides and failovers). It will now be responsible for triggering prompt assembly.
- **Presentational Prompt Builder:** `buildSessionSystemContext` will be stripped of resolution logic and will require a `modelLabel` as input, making it a pure formatting tool.
- **TDD:** Each phase will start with a failing test (Red) and proceed to implementation (Green).
