# Session tool advertising (meta-tool) — design notes

Design exploration for a **meta-tool** that toggles which tools are **advertised** to the model per session, with optional **mid–tool-loop** refresh. **Not implemented**; this document captures agreed direction and open decisions.

## Goals

- Reduce prompt/tool-definition token load for large catalogs by shipping **compact tool metadata** until tools are **enabled**.
- **Full JSON Schema (`parameters`)** for a tool appears **only when that tool is enabled**, not in the meta catalog.
- **FTS/BM25 and existing behavior** elsewhere are unrelated; this doc is only about **tool list exposure**.
- Align with existing Shoggoth patterns: **layered config** (system → agent → session precedence), **policy**, **session** as the primary scope for Discord-bound work.

## Meta-tool behavior (target)

- **Single meta command** (or a small fixed set) for turning tools **on/off** for the session.
- **Meta-tool schema** lists **available tool IDs** and a **single-line description** each (no full parameter schemas).
- **Enabled** tools are injected into the **`tools` list** the model sees; **disabled** tools are omitted once turned off.
- **Batch** operations: **enable and disable** multiple tool IDs in **one** call to limit round-trip / token overhead.
- **Scopes**: meta-tool can be **system-wide**, **per top-level agent**, or **per session** (config model matches other subsystems).

## Always-on set

- A **minimum always-on** set of tools remains advertised regardless of session toggles (exact list TBD).
- **Audit** and **HITL-related** tools should stay **always-on by default** (clarify whether “always-on” means **advertised to the model** vs **operator-only** — some audit paths may not belong in the **agent** tool list at all).

## Principal model: “per agent” vs subagents

- **“Per agent”** applies to **top-level** agents only.
- **Subagents** spawned by a top-level agent **do not** get an independent meta-tool economy by default; simplest rule is **inherit** the parent’s resolved tool mask unless a future design explicitly delegates.

## Single source of truth (SSoT)

- Introduce a dedicated **session tool resolution** step that produces:

  - **Advertised tools** — what goes to `completeWithTools` / OpenAI `tools`.
  - **Executable / routing view** — must satisfy **advertised ⊆ executable** (no model-visible name that cannot be dispatched).
  - **Policy** remains a hard gate: **policy deny** should still be enforceable even if someone misconfigures lists.

- **Inputs** to the resolver:

  - Layered config (system → agent → session).
  - **Policy** allow/deny.
  - **Builtin catalog** + **MCP `tools/list`** (live or last-known-good, see MCP volatility).
  - **Session overlay** (meta-tool mutations), persisted (e.g. SQLite session row or side table).

- **Outputs**: resolved **tool id → full descriptor** (including `parameters`) **only** for enabled tools; meta catalog stays shallow.

**Persistence**: session overlay should survive restarts like other session state; precedence rules match the rest of the stack.

## Mid–tool-loop tool exposure

**Today**: `createSessionToolLoopModelClient` passes the **same** `tools` array on **every** `complete()` inside `runToolLoop` — tool lists are **fixed for the entire** `executeSessionAgentTurn`.

**Target**: allow **refreshing advertised tools between model rounds** (e.g. after meta-tool execution).

**Estimated lift**: **medium** — touches:

1. `ModelClient` / session model client — `tools` as **getter** or **refreshable snapshot** per `complete()`.
2. `runToolLoop` — keep **`options.tools` name allowlist** and **aggregated/executor** consistent with the refreshed advertised set.
3. **Edge cases** — in-flight tool calls vs list shrink; **empty `tools`**; streaming vs non-streaming parity.

**Refresh timing** (decide explicitly):

- **After meta-tool only** (simpler, predictable), vs  
- **After every tool result** (more dynamic, more churn).

## MCP servers and “disconnect”

Two distinct cases:

1. **Normal / ephemeral** (by design): connection or `tools/list` **changes** as part of standard workflow → advertised MCP tools **appear or disappear**; resolver should use **current** catalog (or a deliberate stale cache policy).
2. **Broken / error**: connection fails → similar outward effect but needs **clear degradation** (logs, optional tool result) so the model is not misled by a stale meta catalog.

**Stable IDs**: tool ids must use a **stable namespace** (e.g. `builtin.memory.search`, `sourceId.toolName`) and handle **MCP list changes** after enable.

## Meta catalog vs schema creep

- **Single-line descriptions** in the meta list; avoid embedding full JSON Schema there.
- Optional hint beyond one line: **parameter names only** (or minimal `name: type` tokens) if disambiguation reduces bad calls — keep it **well below** full `parameters` size.

## Batch apply semantics

- **Batch enable + disable** in one meta call.
- Define **atomicity**: **all-or-nothing** if any id is unknown or policy-blocked vs **best-effort partial** apply (preference: **fail closed** or explicit `applied` / `rejected` arrays for transparency).

## Unknown tool IDs

- Decide: **ignore**, **error entire batch**, or **return structured rejection** per id (preferred for operator clarity).

## Provider / platform limits

- Respect **max tools**, **max schema size**; resolver may need to **refuse** or **truncate** with a clear message in tool result or logs.

## Relationship to existing Shoggoth code (reference)

- Tool list construction: `session-mcp-tool-context.ts` (`openAiToolsFromCatalog`, `buildAggregatedMcpCatalog`).
- Fixed tools per loop: `session-tool-loop-model-client.ts` (`tools: input.tools` on each `complete()`).
- Session MCP: `session-mcp-runtime.ts` (`resolveContext(sessionId)`).
- Policy execution gate: tool loop + policy engine (advertising vs deny is **not** unified today).

## Open decisions checklist

- [ ] Exact **always-on** tool set (meta only vs meta + read, etc.).
- [ ] **Audit / HITL**: model-visible vs operator-only tools.
- [ ] **Mid-loop refresh** trigger(s).
- [ ] **Batch** atomicity and error shape.
- [ ] **Subagent** inheritance rules (default: inherit parent mask).
- [ ] **MCP** stale vs live descriptor policy when disconnected.

---

*Captured from design discussion; implementation TBD.*
