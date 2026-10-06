---
date: 2026-10-06
completed: 2026-10-06
---

# Configurable System Gates

## Summary

Adds a `gates` config section so the AGENTS.md discovery gate and the re-read-required gate can be applied to external (MCP) tools by glob, in addition to the builtin handlers they are already hard-wired into. Defaults are empty tool lists, so the feature is off until an operator opts in and existing behavior is byte-identical for unlisted tools.

## Motivation

The two system gates — the AGENTS.md discovery gate (blocks tool execution until the agent reads project instructions) and the re-read-required gate (blocks edits using stale line numbers after file mutations) — only applied to `builtin-*` handlers. MCP-server tools dispatched through the routing executor bypassed them entirely, so external tools could trigger the same conditions (working in an unseen `AGENTS.md` directory, or editing a file whose line numbers went stale) without being gated. Each gate needs a configurable, glob-supported list of tool names it applies to in addition to internal tools.

## Design

A new `createSystemGates(deps)` factory (built once per agent turn) closes over session context and exposes a pre/post hook consumed by the tool loop:

- **`pre`** runs **before HITL** for every tool call whose namespaced name matches the configured globs:
  - AGENTS.md discovery: `checkAgentsMdGate(db, sessionId, cwd, workspacePath)`; returns `JSON.stringify(gate)` if non-null (marks files seen on return, so the model's retry passes — identical to builtin UX).
  - re-read consumer: collects every string value in the tool args as candidate paths (resolved against the working directory, restricted to the workspace), checks `checkReReadRequired(...)` per candidate, and snapshots line counts of existing files into a per-`toolCallId` map for the producer.
- **`post`** runs after successful execution: recounts lines for the snapshot paths; any file whose line count changed is marked via `markReReadRequired(...)` (mirrors the `builtin-replace` producer). External reads do **not** clear flags — the gate message instructs `builtin-read`, which clears them.

Glob matching reuses `toolIdGlobMatches` (`tool-id-glob.ts`), consistent with `contextLevelTools` / `toolDiscovery.alwaysOn`. Gate hooks never fail a tool call: all bodies degrade to no-ops on internal errors (logged via the `system-gates` logger).

### Tool loop integration

- New `RunToolLoopOptions.systemGates?` option (additive; absent ⇒ zero behavior change).
- New `skip_system_gated` dispatch kind.
- **Stage 3.5** — pre-gate before HITL: a gated call records an audit row with phase `system_gated`, pushes the gated payload to the model, appends it to the transcript, and short-circuits. Ordering matters: gates must run before HITL so an approval-worthy external tool is gated first and the operator is not prompted for a call that then gets gated.
- **Stage 5.5** — post-execution producer inside a try/catch; never runs on timeout/error paths.

This placement automatically covers main sessions, subagents, and workflow-task agent turns, since everything routes through `executeSessionAgentTurn`.

### Config schema (`@shoggoth/shared`)

`gates: { agentsMd: { tools: string[] }, reRead: { tools: string[] } }`, both lists defaulting to empty, strict schemas on both levels; plumbed into `sharedConfigFields` (fragment + full schemas), `defaultConfig()`, and the named export barrels. Fragment `deepMerge` replaces arrays wholesale, so a later fragment replaces a `gates.*.tools` list.

## Testing Strategy

Red/green TDD: tests written before the implementation committed against them.

- `packages/shared/test/schema-gates.test.ts` — schema defaults, strictness, fragment/full-config parsing (RED because strict schemas reject the unknown `gates` key).
- `packages/daemon/test/sessions/system-gates.test.ts` — factory behavior: AGENTS.md gating + marked-seen retry pass, non-match passthrough, re-read consumer gate on flagged files, producer line-shift marking (and no re-marking on unchanged files).
- `packages/daemon/test/sessions/tool-loop-system-gates.test.ts` — tool-loop integration: gated `pre` short-circuits (executor never invoked, gated payload in transcript, no HITL row queued), `pre` returning null proceeds normally.

Regression surface: existing gate/tool-loop/MCP tests must keep passing (full `packages/daemon` and `packages/shared` vitest suites, plus both packages' `tsc --noEmit`).

## Considerations

- Glob matching targets the routed namespaced name (e.g. `demo_ext-edit`, `builtin-read`).
- Builtins listed in globs are allowed and gated in addition to their existing internal checks (harmless double-check; first check marks AGENTS.md seen).
- The re-read producer is a design choice mirroring `builtin-replace`; false negatives are acceptable (best-effort path scan of args).
- Path resolution is restricted to the workspace (security boundary).
- Out of scope: workflow-engine `tool` task executors that bypass `runToolLoop`; per-agent overrides. Known follow-ups, not this change.

## Migration

None. The `gates` section is optional in both fragment and full config schemas; existing config files without it keep working unchanged (defaults are `{ agentsMd: { tools: [] }, reRead: { tools: [] } }`).

## References

- [`spec.md`](spec.md) — type signatures, config schema, and hook contract
- [`implementation.md`](implementation.md) — phased implementation steps
