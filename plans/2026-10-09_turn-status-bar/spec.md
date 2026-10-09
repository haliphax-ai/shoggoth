# Specification

Type signatures, schemas, and rendering rules for the turn status bar.

## Configuration

```ts
// packages/shared/src/schema/config.ts — added to the platforms object

export const statusBarConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    statusEnabled: z.boolean().optional(),
    sequenceEnabled: z.boolean().optional(),
    toolCallsEnabled: z.boolean().optional(),
    contextWindowEnabled: z.boolean().optional(),
    compactionsEnabled: z.boolean().optional(),
  })
  .strict()
  .optional();

// platforms: z
//   .object({
//     attachmentHandling: attachmentHandlingSchema,
//     statusBar: statusBarConfigSchema,
//   })
//   .catchall(platformCommonConfigSchema)
//   .optional(),
```

```ts
// packages/shared/src/platform-config.ts

export interface ResolvedStatusBarConfig {
  readonly enabled: boolean;
  readonly statusEnabled: boolean;
  readonly sequenceEnabled: boolean;
  readonly toolCallsEnabled: boolean;
  readonly contextWindowEnabled: boolean;
  readonly compactionsEnabled: boolean;
}

/** Defaults: every section enabled. */
export const DEFAULT_STATUS_BAR_CONFIG: ResolvedStatusBarConfig = {
  enabled: true,
  statusEnabled: true,
  sequenceEnabled: true,
  toolCallsEnabled: true,
  contextWindowEnabled: true,
  compactionsEnabled: true,
};

/** Resolve `platforms.statusBar`, merged over defaults. Env `SHOGGOTH_STATUS_BAR=0` disables entirely. */
export function resolveStatusBarConfig(cfg: ShoggothConfig): ResolvedStatusBarConfig;
```

```jsonc
{
  "platforms": {
    "statusBar": {
      "enabled": true,
      "statusEnabled": true,
      "sequenceEnabled": true,
      "toolCallsEnabled": true,
      "contextWindowEnabled": true,
      "compactionsEnabled": true,
    },
  },
}
```

## Core tracker — `packages/daemon/src/presentation/status-bar.ts`

```ts
export type TurnStatusPhase =
  | "starting"
  | "thinking"
  | "prose"
  | "tool"
  | "finished"
  | "aborted"
  | "failed";

export interface StatusBarToolCall {
  readonly name: string;
  /** First meaningful argument for builtin tools (e.g. `bash` for `builtin-exec`). */
  readonly argPreview?: string;
}

export interface StatusBarSnapshot {
  readonly phase: TurnStatusPhase;
  readonly sequence: number;
  /** Total executed tool calls this turn; last call details while/after running. */
  readonly toolCalls: {
    readonly total: number;
    readonly last?: {
      readonly name: string;
      readonly argPreview?: string;
      readonly running: boolean;
      readonly runtimeMs?: number;
    };
  };
  /** Absent until first usage data. current = latest per-call input tokens. */
  readonly context?: { readonly currentTokens: number; readonly totalTokens: number };
  readonly compactions: number;
}

/** Platform-supplied sink: applies the rendered bar line to the in-flight message. */
export interface StatusBarSink {
  setStatusBar(line: string | null): Promise<void>;
}

/** Platform-supplied renderer (e.g. Discord blockquote line). */
export type StatusBarRenderer = (snap: StatusBarSnapshot, cfg: ResolvedStatusBarConfig) => string;

export interface TurnStatusBar {
  /** Called once when the turn begins; sets phase ⏳ and performs the first render. */
  start(input: {
    sequence: number;
    context?: { currentTokens: number; totalTokens: number };
    compactions: number;
  }): Promise<void>;
  markThinking(): void; // 🧠
  markProse(): void; // 💬
  toolStarted(call: StatusBarToolCall): void; // ⚡
  toolFinished(): void; // records runtime for the last call
  updateContext(currentTokens: number, totalTokens?: number): void;
  setCompactions(count: number): void;
  /** Terminal render (✅/🛑/❌); after this the bar is frozen and timers cleared. */
  finish(outcome: "finished" | "aborted" | "failed"): Promise<void>;
  /** Abandon without a terminal render (e.g. turn dispatch failed before delivery). */
  dispose(): void;
}

export function createTurnStatusBar(opts: {
  cfg: ResolvedStatusBarConfig;
  sink: StatusBarSink;
  render: StatusBarRenderer;
  /** Bar re-render cadence; default 1000 ms. */
  minIntervalMs?: number;
  now?: () => number;
}): TurnStatusBar;
```

Behavior:

- Any state mutation marks the tracker dirty; a render fires when the dirty flag is set and either (a) the 1s cadence window has elapsed, or (b) an external flush (e.g. a prose push about to hit the sink) requests it. Renders always call `sink.setStatusBar` with the full rendered line (or `null` when the bar renders empty because all sections are disabled).
- `finish()` renders immediately (no batching), then freezes. `markX()`/`toolStarted()` after `finish()` are no-ops.
- Tool runtime is measured with `now()` between `toolStarted` and `toolFinished`; a new `toolStarted` while a call is in flight replaces `last` (parallel calls only bump `total`).

## Turn event plumbing — daemon core

```ts
// packages/daemon/src/sessions/tool-loop.ts — RunToolLoopOptions addition
export interface ToolCallEvent {
  readonly phase: "start" | "end";
  readonly name: string;
  readonly argsJson: string;
  /** Present on "end". */
  readonly runtimeMs?: number;
}
readonly onToolCallEvent?: (ev: ToolCallEvent) => void;
```

Fired around `executor.execute` in the dispatch path — only for calls that proceed to execution (not policy-denied, HITL-queued, or validation-skipped dispatches).

```ts
// packages/daemon/src/sessions/session-agent-turn.ts — ExecuteSessionAgentTurnInput addition
readonly events?: {
  /** Reasoning/thinking content is streaming from the model. */
  readonly onThinkingDelta?: (accumulated: string) => void;
  readonly onToolCall?: (ev: ToolCallEvent) => void;
  /** A mid-turn compaction completed. */
  readonly onCompaction?: () => void;
};
```

```ts
// packages/daemon/src/sessions/session-agent-turn.ts — SessionAgentTurnResult change
export interface SessionAgentTurnResult {
  readonly failoverMeta: SessionToolLoopFailoverState | undefined;
  readonly latestAssistantText: string;
  readonly showAttachments?: readonly OutboundAttachment[];
  /** NEW — maps to 🛑/❌/✅ in the status bar. */
  readonly outcome: "completed" | "aborted" | "failed";
}
```

- `TurnAbortedError` branch → `"aborted"`; catch-all error branch → `"failed"`; normal completion → `"completed"`.

```ts
// packages/models/src/openai-compatible.ts — stream options addition
readonly onReasoningDelta?: (delta: string, accumulated: string) => void;
```

Emitted from the SSE parser wherever `reasoningBuf` accumulates; threaded through `tool-failover.ts` `completeWithTools` like `onTextDelta`, then mapped to `onThinkingDelta` in `createSessionToolLoopModelClient` (which gains `onThinkingDelta` and `onCompaction` inputs; `onCompaction` fires when the mid-turn compaction path completes with `compacted: true`).

## Platform contract

```ts
// packages/daemon/src/presentation/platform-adapter.ts
export interface StreamHandle {
  setFullContent(text: string): Promise<void>;
  pushUpdate(text: string): Promise<void>;
  /** NEW, optional: apply the rendered status bar to the in-flight message. */
  setStatusBar?(line: string | null): Promise<void>;
}

// sendBody / sendError opts gain:
readonly statusBar?: string; // pre-rendered bar line, appended by the platform
```

```ts
// packages/daemon/src/presentation/turn-orchestrator.ts — deps addition
readonly statusBar?: {
  readonly config: ResolvedStatusBarConfig;
  readonly render: StatusBarRenderer;
  /** Wraps a stream handle with a bar sink; returns the same handle augmented. */
  readonly attachSink: (handle: StreamHandle) => StatusBarSink;
};
```

`runInboundSessionTurn` options gain an optional `statusBar` factory mirroring the above; it creates the tracker at turn start, forwards `events` into `executeSessionAgentTurn`, and on completion calls `finish(outcome)` before the final `setFullContent`/`sendAssistantBody`/`sendErrorBody` (bar line included in the same message edit/send).

## Discord rendering — `packages/platform-discord/src/status-bar.ts`

```ts
export function renderDiscordStatusBar(
  snap: StatusBarSnapshot,
  cfg: ResolvedStatusBarConfig,
): string;
```

Format (sections joined with `｜`):

| Section     | Format                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Status      | `⏳` `🧠` `💬` `⚡` `✅` `🛑` `❌`                                                                                             |
| Sequence    | `` 🔢 `217` ``                                                                                                                 |
| Tool calls  | `` 🔧 `34` `` + ` `**`builtin-exec:bash`**``while running /` `​`builtin-exec:bash`​` 34ms`when idle; omitted when`total === 0` |
| Context     | ``🪟 `10.1K/1M` **10.1%**``; omitted until usage data exists                                                                   |
| Compactions | `` 🗑️ `1` ``                                                                                                                   |

- Token formatting: `<10K` → plain integer with thousands separators; `≥10K` → one-decimal K; `≥1M` → one-decimal M. Percentage: one decimal.
- Builtin arg extract: for `builtin-*` tools, the first string/argv entry of `argsJson`; for `builtin-exec`, `argv[1]` (the executable).
- Message body assembly: `\n\n> <line>` appended to the **last** chunk. In `streaming.ts`, the split budget becomes `maxContentLength - (line.length + 2)` while a bar is active; `setStatusBar` re-edits using the last pushed text.
- Bar ordering vs. model tag footer: the footer is part of the assistant body, so the bar lands after it (end of message).

## Example lifecycles

```
⏳ ｜ 🔢 `217` ｜ 🪟 `8.2K/1M` ｜ 🗑️ `1`          (turn start)
🧠 ｜ 🔢 `217` ｜ 🪟 `9.0K/1M` ｜ 🗑️ `1`          (reasoning delta)
💬 ｜ 🔢 `217` ｜ 🪟 `10.3K/1M` **10.3%** ｜ 🗑️ `1` (prose streaming)
⚡ ｜ 🔢 `217` ｜ 🔧 `1` **builtin-read** ｜ 🪟 `11.0K/1M` ｜ 🗑️ `1` (tool running)
⚡ ｜ 🔢 `217` ｜ 🔧 `2` `builtin-read` 120ms ｜ 🪟 `12.4K/1M` ｜ 🗑️ `1` (tool done, prose again would show 💬)
✅ ｜ 🔢 `217` ｜ 🔧 `2` `builtin-read` 120ms ｜ 🪟 `13.1K/1M` **13.1%** ｜ 🗑️ `1` (terminal, frozen)
```
