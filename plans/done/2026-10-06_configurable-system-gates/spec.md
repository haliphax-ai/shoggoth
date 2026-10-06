# Specification

## Interfaces

### Config schema (`packages/shared/src/schema/gates.ts`)

```ts
const gateToolListSchema = z.object({ tools: z.array(z.string().min(1)).default([]) }).strict();

export const shoggothGatesConfigSchema = z
  .object({
    agentsMd: gateToolListSchema.default({ tools: [] }),
    reRead: gateToolListSchema.default({ tools: [] }),
  })
  .strict()
  .default({ agentsMd: { tools: [] }, reRead: { tools: [] } });

export type ShoggothGatesConfig = z.infer<typeof shoggothGatesConfigSchema>;
export const DEFAULT_GATES_CONFIG: ShoggothGatesConfig = {
  agentsMd: { tools: [] },
  reRead: { tools: [] },
};
```

Plumbed into `sharedConfigFields` (`gates: shoggothGatesConfigSchema.optional()`), `defaultConfig()` (`gates: DEFAULT_GATES_CONFIG`), the `schema.ts` barrel, and the named exports in `index.ts` (`shoggothGatesConfigSchema`, `DEFAULT_GATES_CONFIG`, `type ShoggothGatesConfig`).

### System gates factory (`packages/daemon/src/sessions/system-gates.ts`)

```ts
export interface SystemGatesDeps {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly contextSegmentId: string;
  readonly workspacePath: string;
  /** Read `config.gates` (tolerate undefined). */
  readonly config: ShoggothConfig;
  /** Fresh per call (mid-turn `cd` visibility). */
  readonly getWorkingDirectory: () => string | undefined;
}

export interface SystemGatesHook {
  /** Returns a gate resultJson to short-circuit with, or null to proceed. Runs BEFORE HITL. */
  pre(input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }): Promise<{ resultJson: string } | null>;
  /** Post-execution producer (re-read marking). Must never throw. */
  post(input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    resultJson: string;
  }): Promise<void>;
}

export function createSystemGates(deps: SystemGatesDeps): SystemGatesHook;
```

### Tool loop (`packages/daemon/src/sessions/tool-loop.ts`)

```ts
export interface RunToolLoopOptions {
  // ...
  /** When set, configurable system gates (AGENTS.md / re-read) run before HITL and after execution. */
  readonly systemGates?: SystemGatesHook;
}

export type ToolCallDispatchResultKind =
  | "skip_validation_error"
  | "skip_policy_denied"
  | "skip_review_unavailable"
  | "skip_system_gated" // new
  | "skip_hitl_denied"
  | "proceed";
```

## Data Structures / Schemas

Example config fragment:

```jsonc
{
  "gates": {
    "agentsMd": { "tools": ["demo_ext-*"] },
    "reRead": { "tools": ["filesystem-write"] },
  },
}
```

Glob matching targets the routed namespaced tool name (e.g. `demo_ext-edit`, `builtin-read`), consistent with `contextLevelTools` / `toolDiscovery.alwaysOn`. `deepMerge` replaces arrays, so a later fragment replaces a `gates.*.tools` list wholesale.

## Code Examples

```ts
const systemGates = createSystemGates({
  db: input.db,
  sessionId: input.sessionId,
  contextSegmentId: ctxSeg,
  workspacePath: input.session.workspacePath,
  config: input.config,
  getWorkingDirectory: () => {
    const wd = getWorkingDirStmt.get(input.sessionId) as
      | { working_directory: string | null }
      | undefined;
    return wd?.working_directory?.trim() || undefined;
  },
});

// In the tool loop (pre-execution, before HITL):
const gated = await options.systemGates.pre({
  toolName: tc.name,
  args: toolArgs,
  toolCallId: tc.id,
});
if (gated) {
  options.audit.record({ phase: "system_gated", tool: compoundResource, toolCallId: tc.id });
  options.model.pushToolMessage?.({ toolCallId: tc.id, content: gated.resultJson });
  // ...append to transcript, return { kind: "skip_system_gated" }
}
```
