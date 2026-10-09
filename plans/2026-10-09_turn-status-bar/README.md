---
date: 2026-10-09
completed: never
---

# Turn Status Bar

## Summary

Adds a live status bar — rendered as a blockquote at the end of every agent reply — that tracks turn status, sequence number, tool calls, context window usage, and compactions during streaming output and at the end of at-once deliveries. Tracked in [#360](https://github.com/haliphax-ai/shoggoth/issues/360).

## Motivation

Once a turn starts, the operator currently has little visibility into what the agent is doing: a streaming message grows, but there is no indication of whether the model is thinking, writing prose, or executing tools, how much of the context window is consumed, or how many tool calls have run. A compact status footer gives continuous feedback without cluttering the transcript, and its terminal state (✅/🛑/❌) makes the outcome of every turn explicit at a glance.

## Design

### Anatomy

The bar is a single blockquote line appended to the end of the message body:

```
> ⚡ ｜ 🔢 `217` ｜ 🔧 `34` **builtin-exec:bash** ｜ 🪟 `10.1K/1M` **10.1%** ｜ 🗑️ `1`
```

Sections, left to right, each individually toggleable (all enabled by default):

| Section        | Contents                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status         | ⏳ starting · 🧠 thinking · 💬 generating prose · ⚡ calling tools · ⏸️ awaiting HITL approval · ✅ turn finished · 🛑 turn aborted · ❌ turn failed                                                                                                                           |
| Sequence       | Current turn sequence number (`session_stats.turn_count`)                                                                                                                                                                                                                      |
| Tool calls     | Total calls this turn; last call's tool name — **bold** while running, monospace when idle or awaiting HITL approval; runtime of the last (idle) call; arg extract for `builtin-*` tools (e.g. `builtin-exec:bash`); section omitted when no calls have run and none is queued |
| Context window | Current/total tokens and percentage used                                                                                                                                                                                                                                       |
| Compactions    | Compaction count for the current context segment                                                                                                                                                                                                                               |

### Architecture

The feature splits along the existing presentation/platform boundary:

- **Config** (`shared`): a new `platforms.statusBar` block (sibling of platform ids, alongside `platforms.attachmentHandling`) with a zod schema and a resolver. Defaults: everything enabled.
- **Status tracker** (`daemon` presentation layer): a platform-agnostic state machine (`createTurnStatusBar`) that receives turn events (phase transitions, tool call start/end, usage deltas, compactions), holds the latest snapshot, and pushes re-renders to a sink at most once per second. Terminal states freeze the bar.
- **Event sources** (daemon core): new optional callbacks threaded through the existing seams — `RunToolLoopOptions.onToolCallEvent` in `tool-loop.ts`, `onThinkingDelta`/`onCompaction` on the session tool-loop model client, `onHitlQueued` surfaced from the HITL enqueue hook (⏸️), and a `reasoning` delta callback in the models SSE stream parser. `SessionAgentTurnResult` gains an `outcome: "completed" | "aborted" | "failed"` field so callers can distinguish the 🛑 abort path (currently swallowed into a normal result with `"<Aborted>"` appended) from success.
- **Platform contract**: `StreamHandle` gains an optional `setStatusBar(line)` method; `PlatformAdapter.sendBody`/`sendError` gain an optional `statusBar` option. The platform renders the snapshot (emoji line) via a renderer it supplies to the presentation layer — blockquote syntax, token formatting, and chunk-splitting interplay stay platform-owned.
- **Discord** (`platform-discord`): the streaming outbound stores the current bar line and re-edits the message when it changes; the bar is appended to the _last_ chunk after message splitting (split budget reduced by the bar's length so the 2000-char limit still holds). At-once deliveries append the bar before splitting. Both call sites in `platform.ts` (inbound turns and `messaging_surface` delivery) wire the tracker.

### Update flow

- Prose deltas already coalesce through `createCoalescingStreamPusher` at `streamMinIntervalMs`; the tracker marks itself dirty and re-renders on its own 1s cadence (or immediately when a prose push flushes and the bar text changed — context/usage updates ride along with prose pushes, as no separate round trip is needed).
- Streaming is not required for the bar: during non-streaming turns, tool/phase events still update the tracker, and the bar is attached once at delivery time.
- The terminal render (✅/🛑/❌) bypasses batching and ships with the final `setFullContent`/`sendAssistantBody`/`sendErrorBody` call.

### Decisions

- **Bar position**: appended after everything else, including the model tag footer, keeping "status at the end of the message" literal.
- **Context "current" mid-turn**: derived from the latest per-model-call `inputTokens` (each call resends full history, so it approximates live context fill cheaply); falls back to `estimateCurrentContextFill` for at-once deliveries. Total comes from the usage payload or model metadata.
- **Sequence**: read from `session_stats.turn_count` at turn start; adjusted by the increment call site's semantics (increment at start → use as-is).
- **Counted tool calls**: only calls that proceed to execution count toward the total; policy-denied, HITL-queued, and validation-skipped dispatches do not.

## Testing Strategy

Red/green TDD per project rules; each phase ships with its tests.

- **Tracker state machine** (unit, fake timers): all phase transitions, terminal freeze, batching cadence, section toggles omitting content, no-op renders.
- **Renderer** (unit/snapshot): every status emoji (including ⏸️), running vs. idle vs. HITL-queued tool display, builtin arg extract, token/percentage formatting across magnitudes (K/M), omitted sections.
- **Config**: schema defaults, resolver precedence over missing/partial blocks.
- **Discord streaming outbound**: bar appended to last chunk only; split budget accounts for bar length; bar update triggers a single edit; final content keeps the bar.
- **Tool loop**: `onToolCallEvent` ordering (start → end), runtime measurement, non-executed dispatches excluded.
- **Turn executor**: `outcome` flags for completed / aborted / failed paths.
- **Integration** (`runInboundSessionTurn` with fakes): full lifecycle with streaming sink (✅), abort (🛑), failure (❌); at-once delivery carries the bar.
- **Type check / lint / full suite** via git hooks on push.

## Considerations

- **Rate limits**: at most one extra message edit per second per stream for bar-only changes; prose and bar changes share the same edit path, so combined cost is unchanged from today.
- **HITL pauses**: dedicated ⏸️ state, entered when a pending approval row is queued (the queued tool's name appears in the tool section without a runtime or count) and exited when the tool executes (⚡) or the next model round emits a thinking/prose delta — the bar may sit at ⏸️ briefly after a denial while the next round spins up. Terminal states (✅/🛑/❌) always win over ⏸️.
- **Thinking detection limits**: only providers exposing reasoning deltas (openai-compatible `reasoning_content` streams) can show 🧠 mid-stream; providers whose thinking is normalized into content will read as 💬. Acceptable approximation; anthropic/gemini reasoning deltas can be added later.
- **Internal/subagent delivery**: turns with `delivery.kind !== "messaging_surface"` have no visible surface and skip the bar entirely.
- **`/status` and system-prompt stats**: unchanged; the bar reuses the same underlying `session_stats` data.
- **Default-on behavior**: message content changes for all users by default — acceptable for pre-release ("It's Okay to Break Things"), but worth calling out in the PR.
- **Discord-only renderer for now**: the renderer is injected by the platform, so future platforms supply their own without touching the tracker.

## Migration

None. New config block; all fields optional with enabled-by-default semantics. No schema or data migration.

## References

- [`spec.md`](spec.md) — type signatures, schemas, and rendering rules
- [`implementation.md`](implementation.md) — phased implementation steps
- Issue [#360](https://github.com/haliphax-ai/shoggoth/issues/360) — track turn status in footer of message
