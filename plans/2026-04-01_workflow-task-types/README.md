# Workflow Task Types

**Date:** 2026-04-01
**Status:** Planned

## Summary

Extend the workflow orchestrator to support task types beyond agent turns: tool calls, conditional gates, and template/transform tasks. These allow workflows to execute mechanical operations without burning LLM turns, introduce dynamic branching, and reshape data between steps.

## Motivation

Currently, every workflow task spawns a subagent session and runs a model turn. Many workflow steps don't require reasoning — running a shell command, checking a condition, or reformatting output are all mechanical. Executing these as agent turns wastes tokens, adds latency, and introduces unnecessary nondeterminism.

## Design

### TaskDef Discriminated Union

Replace the flat `TaskDef` with a discriminated union keyed on `kind`. The existing behavior becomes `kind: "agent"`.

```typescript
interface TaskDefBase {
  id: number;
  title?: string;
  failureBehavior: FailureBehavior;
  failureNotification: FailureNotification;
  runtimeLimitMs?: number;
  /** Optional template to reshape task output before downstream consumption. */
  outputTemplate?: string;
}

interface AgentTaskDef extends TaskDefBase {
  kind: "agent";
  prompt: string;
}

interface ToolTaskDef extends TaskDefBase {
  kind: "tool";
  /** Tool name (e.g., "builtin.exec", "builtin.read_file"). */
  tool: string;
  /** Tool arguments. Supports {{task:N:output}} template refs. */
  args: Record<string, unknown>;
}

interface GateTaskDef extends TaskDefBase {
  kind: "gate";
  /** Condition expression evaluated against upstream task results. */
  condition: string;
}

interface TransformTaskDef extends TaskDefBase {
  kind: "transform";
  /** Template string with {{task:N:output}} / {{task:N:success}} refs. */
  template: string;
}

type TaskDef = AgentTaskDef | ToolTaskDef | GateTaskDef | TransformTaskDef;
```

### Task Execution by Kind

The orchestrator's `spawnTask` method becomes a dispatcher:

- **agent** — existing behavior: spawn subagent session, run model turn, capture assistant text as output.
- **tool** — resolve template refs in `args`, execute the tool directly (no subagent, no model turn), capture the result as output. On error, mark as failed.
- **gate** — evaluate `condition` against upstream task outputs. If truthy, mark as done with output `"pass"`. If falsy, mark as done with output `"skip"` and propagate skip to all downstream dependents (new status: `skipped`).
- **transform** — resolve `template` using `resolveTemplates`, store the result as output, mark as done. Pure string interpolation, no execution.

### Tool Execution

Tool tasks execute via a `ToolExecutor` adapter injected into the orchestrator:

```typescript
interface ToolExecutor {
  execute(tool: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    output: string;
    error?: string;
  }>;
}
```

The daemon wires this to the existing MCP tool infrastructure. Builtin tools:

- `builtin.exec` — run a shell command, capture stdout/stderr. Args: `{ argv: string[], timeout?: number, cwd?: string }`.
- `builtin.read_file` — read a file. Args: `{ path: string }`.
- `builtin.write_file` — write a file. Args: `{ path: string, content: string }`.

MCP-registered tools are also available by their full name.

### Gate Conditions

Gate conditions are simple expressions evaluated against a context object:

```typescript
{
  task: {
    1: { output: "...", success: true },
    2: { output: "...", success: false },
  }
}
```

Expression syntax — keep it minimal and safe:

- Comparison: `task.2.success == true`, `task.1.output contains "PASS"`
- Logical: `task.1.success && task.2.success`, `task.1.success || task.3.success`
- Negation: `!task.2.success`

No arbitrary JS eval. Implement a small expression parser or use a safe subset evaluator.

### Skipped Status

Gates introduce a new task status: `skipped`. When a gate evaluates to falsy:

1. The gate task itself is marked `done` with output `"skip"`.
2. All tasks that transitively depend on the gate are marked `skipped`.
3. Skipped tasks do not block workflow completion.
4. Skipped tasks are rendered with a ⏭️ emoji in status messages.

This requires changes to:
- `TaskStatus` type: add `"skipped"`
- `isTerminal`: treat `skipped` as terminal
- `markBlockedTasks`: propagate skip from gate tasks
- `formatTaskLine` / `formatSummaryMessage`: handle skipped rendering

### Output Templates

Any task type can have an optional `outputTemplate` field. When present, the raw task output is passed through the template before being stored:

```json
{
  "id": 3,
  "kind": "tool",
  "tool": "builtin.exec",
  "args": { "argv": ["npm", "test"] },
  "outputTemplate": "Test result: {{self.output}}",
  "title": "Run tests"
}
```

Special refs for output templates:
- `{{self.output}}` — the raw output of this task
- `{{self.exitCode}}` — exit code (tool/exec tasks only)
- `{{self.error}}` — error message if failed

This runs after task completion, before the output is stored in `TaskState.output`.

### Tool Descriptor Changes

The tool descriptor's `tasks` array item schema gains a `kind` field and conditional properties:

```json
{
  "kind": { "type": "string", "enum": ["agent", "tool", "gate", "transform"], "default": "agent" },
  "prompt": { "type": "string", "description": "Agent task prompt." },
  "tool": { "type": "string", "description": "Tool task: tool name." },
  "args": { "type": "object", "description": "Tool task: tool arguments." },
  "condition": { "type": "string", "description": "Gate task: condition expression." },
  "template": { "type": "string", "description": "Transform task: output template." },
  "output_template": { "type": "string", "description": "Optional: reshape output before downstream consumption." }
}
```

`kind` defaults to `"agent"` when not specified — it's the common case and keeps task definitions concise.

### Tool Handler Changes

`TaskInput` gains the new fields. `toTaskDefs` maps them to the discriminated union. Validation ensures the right fields are present for each kind:

- `agent` requires `prompt`
- `tool` requires `tool` and `args`
- `gate` requires `condition`
- `transform` requires `template`

## Implementation Phases

### Phase 1: TaskDef Union

- Refactor `TaskDef` into the discriminated union
- Default `kind` to `"agent"` when not specified
- Update all existing references to `taskDef.prompt` to use type narrowing
- Update tool descriptor and handler for the new task kinds

**Files:**
- `packages/workflow/src/types.ts`
- `packages/workflow/src/tool-handler.ts`
- `packages/workflow/src/tool-descriptor.ts`
- `packages/workflow/src/orchestrator.ts`
- `packages/workflow/src/status-message.ts`
- `packages/workflow/src/state.ts` (serialization)

### Phase 2: Tool Tasks

- Add `ToolExecutor` interface to orchestrator
- Implement tool task dispatch in the orchestrator's tick loop
- Wire `ToolExecutor` in the daemon (builtin tools + MCP bridge)
- Template ref resolution in tool args
- Tests for tool task execution, failure handling, output capture

**Files:**
- `packages/workflow/src/orchestrator.ts`
- `packages/workflow/src/types.ts`
- `packages/daemon/src/workflow-singleton.ts`
- `packages/daemon/src/index.ts`

### Phase 3: Transform Tasks

- Implement transform task dispatch (resolve template, store output)
- Reuse existing `resolveTemplates` infrastructure
- Tests for template resolution, edge cases

**Files:**
- `packages/workflow/src/orchestrator.ts`
- `packages/workflow/src/templates.ts` (if extensions needed)

### Phase 4: Gate Tasks + Skipped Status

- Add `skipped` to `TaskStatus`
- Implement gate condition evaluator (safe expression parser)
- Implement skip propagation in the orchestrator
- Update status message rendering (⏭️ emoji)
- Update summary message to account for skipped tasks
- Tests for gate evaluation, skip propagation, rendering

**Files:**
- `packages/workflow/src/types.ts`
- `packages/workflow/src/orchestrator.ts`
- `packages/workflow/src/status-message.ts`
- `packages/workflow/src/hardening.ts` (valid transitions)
- New: `packages/workflow/src/gate-eval.ts`

### Phase 5: Output Templates

- Add `outputTemplate` field to `TaskDefBase`
- Implement post-completion output reshaping
- Support `{{self.output}}`, `{{self.exitCode}}`, `{{self.error}}` refs
- Tests for output template application across all task types

**Files:**
- `packages/workflow/src/types.ts`
- `packages/workflow/src/orchestrator.ts`
- `packages/workflow/src/templates.ts`

### Phase 6: Builtin Tools

- Implement `builtin.exec` (shell execution with timeout, stdout/stderr capture)
- Implement `builtin.read_file` and `builtin.write_file`
- Security: validate tool names, enforce allowlists, sandbox exec
- Tests for each builtin

**Files:**
- New: `packages/workflow/src/builtin-tools.ts`
- `packages/daemon/src/index.ts` (wiring)

## Testing Strategy

Each phase includes unit tests for the new functionality. Integration tests should cover:

- Mixed-type workflows (agent + tool + gate + transform in one graph)
- Gate skip propagation across complex dependency graphs
- Template resolution chains (transform output feeding into agent prompt)
- Tool failure → failure notification → parent delivery

## Migration

None. Existing workflow state files on disk are invalidated — wipe `workflow-state/` on deploy.

## Security Considerations

- **Tool execution:** `builtin.exec` must respect the same sandboxing as agent tool calls. No arbitrary command execution without the same guardrails.
- **Gate conditions:** No `eval()`. Purpose-built expression parser only.
- **Template injection:** Output templates should not allow recursive template expansion (no template refs in template output).
