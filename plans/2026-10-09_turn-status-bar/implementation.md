# Implementation

Phased implementation steps. Each phase is independently shippable and testable; additive work (new modules, new options) precedes integration work (touching existing call paths). Red/green TDD per phase. No card/ticket identifiers in commits, code comments, or PR text — reference issue `#360` only in the PR body.

## Phase 1: Status bar config (shared)

Schema and resolver for `platforms.statusBar`.

- Add `statusBarConfigSchema` to `packages/shared/src/schema/config.ts` and wire it into the `platforms` object alongside `attachmentHandling` (no clash with the platform-id catchall).
- Add `ResolvedStatusBarConfig`, `DEFAULT_STATUS_BAR_CONFIG`, and `resolveStatusBarConfig()` to `packages/shared/src/platform-config.ts`; honor `SHOGGOTH_STATUS_BAR=0` as a global kill switch (env wins, matching other platform flags).
- Export new symbols from `packages/shared/src/index.ts`.
- Tests: defaults when absent; partial blocks merged over defaults; env override.

**Files:**

- `packages/shared/src/schema/config.ts`
- `packages/shared/src/platform-config.ts`
- `packages/shared/src/index.ts`
- `packages/shared/test/status-bar-config.test.ts`

## Phase 2: Reasoning deltas (models)

Emit streaming reasoning/thinking deltas so the tracker can show 🧠.

- Add `onReasoningDelta?: (delta: string, accumulated: string) => void` to the SSE stream options in `packages/models/src/openai-compatible.ts`; emit wherever `reasoningBuf` accumulates a chunk.
- Thread through `packages/models/src/tool-failover.ts` `completeWithTools` stream options (same path as `onTextDelta`).
- Tests: SSE fixture with interleaved `reasoning_content` and `content` chunks fires the callback with correct accumulated values; absence of reasoning produces no calls. Anthropic/gemini providers are out of scope (follow-up).

**Files:**

- `packages/models/src/openai-compatible.ts`
- `packages/models/src/tool-failover.ts`
- `packages/models/test/…` (existing stream test files)

## Phase 3: Status bar tracker + Discord renderer (additive modules)

New platform-agnostic tracker and the Discord renderer, both fully unit-tested in isolation with no call-site changes yet.

- Create `createTurnStatusBar()` per [`spec.md`](spec.md): state machine, dirty tracking, 1s batched renders, terminal freeze, `null` render when all sections off.
- Create `renderDiscordStatusBar()`: section toggles, token/percent formatting, running (bold) vs. idle (monospace + runtime) tool display, builtin arg extract, omission rules.
- Tests: fake timers for batching cadence and terminal flush; snapshot-style tests per phase/section combination; arg-extract cases for `builtin-exec` (argv executable) and generic builtins.

**Files:**

- `packages/daemon/src/presentation/status-bar.ts`
- `packages/daemon/test/presentation/status-bar.test.ts`
- `packages/platform-discord/src/status-bar.ts`
- `packages/platform-discord/test/status-bar.test.ts`

## Phase 4: Turn event plumbing (daemon core)

New optional callbacks and the `outcome` result field. Existing behavior unchanged when callbacks are absent; this phase owns fixing any tests broken by the `SessionAgentTurnResult` change.

- `packages/daemon/src/sessions/tool-loop.ts`: add `ToolCallEvent` + `onToolCallEvent` to `RunToolLoopOptions`; fire around `executor.execute` in the dispatch path (start/end, runtime measured) for executed calls only.
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts`: add `onThinkingDelta` (wired to the model client's `onReasoningDelta`) and `onCompaction` (fires when mid-turn compaction completes with `compacted: true`).
- `packages/daemon/src/sessions/session-agent-turn.ts`: add `input.events` (forwarded to model client + loop impl); set `outcome` on all three return paths (`completed` / `aborted` / `failed`); update all construction sites of `SessionAgentTurnResult`.
- Tests: event ordering across a multi-hop tool loop; runtime measurement; abort path returns `"aborted"`; catch-all error path returns `"failed"`; skipped dispatches emit no events.

**Files:**

- `packages/daemon/src/sessions/tool-loop.ts`
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts`
- `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/test/sessions/tool-loop.test.ts` (or new event-focused test file)
- Affected tests touching `SessionAgentTurnResult`

## Phase 5: Platform contract + presentation integration

Wire the tracker through the presentation layer (still platform-agnostic; sinks/renderers injected).

- `packages/daemon/src/presentation/platform-adapter.ts`: optional `StreamHandle.setStatusBar`; optional `statusBar` on `sendBody`/`sendError` opts.
- `packages/daemon/src/messaging/inbound-session-turn.ts`: optional `statusBar` factory in options; create tracker at turn start (sequence from `session_stats.turn_count`, compactions from stats, context from stats/model metadata), forward `events` into `executeSessionAgentTurn`, call `finish(outcome)` before the final delivery (streaming: last `setFullContent` carries the bar; at-once: bar passed with `sendAssistantBody`; errors: bar with `sendErrorBody`). Skip entirely when disabled.
- `packages/daemon/src/presentation/turn-orchestrator.ts`: optional `statusBar` dep (config + renderer + `attachSink`); wrap pre-started/lazy stream handles; pass through to `runInboundSessionTurn`.
- `packages/daemon/src/lib.ts`: export new symbols for platform consumption.
- Tests: integration tests with fake adapter/sink covering ✅/🛑/❌ lifecycles, at-once delivery with bar, disabled config no-op, and non-messaging delivery untouched.

**Files:**

- `packages/daemon/src/presentation/platform-adapter.ts`
- `packages/daemon/src/messaging/inbound-session-turn.ts`
- `packages/daemon/src/presentation/turn-orchestrator.ts`
- `packages/daemon/src/lib.ts`
- `packages/daemon/test/messaging/inbound-session-turn.test.ts` (and/or new status-bar integration test file)

## Phase 6: Discord platform wiring

Apply the bar in Discord transports and both turn call sites.

- `packages/platform-discord/src/streaming.ts`: track `statusBarLine`; `setStatusBar` re-edits using last pushed/full content; split budget reduced by bar length so the 2000-char limit holds across chunks; bar lands on the last chunk.
- `packages/platform-discord/src/discord-platform-adapter.ts`: implement `setStatusBar` on wrapped stream handles; append pre-rendered `statusBar` line in `sendBody`/`sendError`.
- `packages/platform-discord/src/platform.ts`: build the `statusBar` dep (resolve config via `resolveStatusBarConfig`, `renderDiscordStatusBar`, sink adapter) for `PresentationTurnOrchestrator`; wire the `messaging_surface` path in `runSessionModelTurn` (tracker around its own stream pusher, terminal bar on `setFullContent`/`sendBody`); sequence/compaction/context reads from `session_stats`.
- Tests: streaming outbound chunk-budget + bar placement; `setStatusBar` edit behavior; messaging_surface lifecycle.

**Files:**

- `packages/platform-discord/src/streaming.ts`
- `packages/platform-discord/src/discord-platform-adapter.ts`
- `packages/platform-discord/src/platform.ts`
- `packages/platform-discord/test/streaming.test.ts` (and adapter/platform tests)

## Phase 7: Documentation + verification

- Document `platforms.statusBar` in the config reference under `docs/`.
- Full type check, lint, format, and test suite via git hooks.
- Manual smoke test against the test bot: streaming turn (all sections), `session_abort` mid-turn (🛑), a failing turn (❌), config toggles off/on.
- Update this plan's frontmatter and move to `plans/done/` once all phases land on main.

**Files:**

- `docs/` (config reference)
- `plans/2026-10-09_turn-status-bar/` (completion bookkeeping)
