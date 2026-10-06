# Implementation

## Phase 1: Config schema (`@shoggoth/shared`)

Additive schema section for the system gates.

- Create `packages/shared/src/schema/gates.ts` with `shoggothGatesConfigSchema`, `ShoggothGatesConfig`, `DEFAULT_GATES_CONFIG`.
- Add `gates: shoggothGatesConfigSchema.optional()` to `sharedConfigFields` in `packages/shared/src/schema/config.ts` and `gates: DEFAULT_GATES_CONFIG` to `defaultConfig()`.
- Export from `packages/shared/src/schema.ts` and the named barrel `packages/shared/src/index.ts`.
- RED/GREEN: `packages/shared/test/schema-gates.test.ts` (defaults, strictness, fragment/full parsing).

**Files:**

- `packages/shared/src/schema/gates.ts`
- `packages/shared/src/schema/config.ts`
- `packages/shared/src/schema.ts`
- `packages/shared/src/index.ts`
- `packages/shared/test/schema-gates.test.ts`

## Phase 2: System gates factory (daemon)

- Create `packages/daemon/src/sessions/system-gates.ts` implementing `createSystemGates(deps)` with the pre/post hook contract (AGENTS.md gate, re-read consumer + line-count snapshot, re-read producer).
- RED/GREEN: `packages/daemon/test/sessions/system-gates.test.ts`.

**Files:**

- `packages/daemon/src/sessions/system-gates.ts`
- `packages/daemon/test/sessions/system-gates.test.ts`

## Phase 3: Tool-loop integration + wiring

Additive changes to the tool loop and agent turn.

- `packages/daemon/src/sessions/tool-loop.ts`: `RunToolLoopOptions.systemGates?`, `skip_system_gated` kind, Stage 3.5 pre-gate (before HITL), Stage 5.5 post-execution producer.
- `packages/daemon/src/sessions/session-agent-turn.ts`: build `createSystemGates(...)` once per turn and pass it into `loopImpl`.
- RED/GREEN: `packages/daemon/test/sessions/tool-loop-system-gates.test.ts` (short-circuit before HITL; pass-through on null).
- Regression: full `packages/daemon` and `packages/shared` vitest suites + both packages' `tsc --noEmit`.

**Files:**

- `packages/daemon/src/sessions/tool-loop.ts`
- `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/test/sessions/tool-loop-system-gates.test.ts`

## Phase 4: Docs

- `docs/shared.md`: `ShoggothGatesConfig` row in the config types table and `DEFAULT_GATES_CONFIG` in the constants table.
- `docs/daemon.md`: "System Gates" section documenting the two gates, glob lists, namespaced-name matching, empty defaults, gate-before-HITL ordering, and that external reads do not clear re-read flags.

**Files:**

- `docs/shared.md`
- `docs/daemon.md`
