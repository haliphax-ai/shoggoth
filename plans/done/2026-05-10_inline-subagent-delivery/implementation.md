# Implementation

## Phase 1: Core Delivery Mode Logic

Add the `delivery_mode` parameter to the control plane op and modify `deliverSubagentResult()` to respect it. Add max-char truncation and system context framing.

- Read `delivery_mode` from spawn payload, default to `"inline"`
- Store `delivery_mode` and `respond_to` on the session row (needed for persistent all-turn delivery)
- Modify `deliverSubagentResult()`: handle `drop` (no-op), `inline` (try steer, fall back to queue), `queue` (always enqueue)
- Add 8000-char truncation to delivered text
- Wrap delivered content in the trusted system context envelope

**Files:**

- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/src/sessions/session-store.ts`

## Phase 2: All-Turn Delivery for Persistent Subagents

Hook into the turn completion path for persistent subagent sessions so that every turn (not just the first) delivers its result to the parent.

- Identify where subsequent persistent subagent turns complete (platform inbound message handler or session-agent-turn)
- After turn completion, look up the session's `subagentDeliveryMode` and `subagentRespondTo`
- Call `deliverSubagentResult()` for non-thread-bound persistent subagents on every turn

**Files:**

- `packages/daemon/src/control/integration-ops.ts` (or wherever subsequent turns resolve)
- `packages/daemon/src/messaging/inbound-session-turn.ts` (likely hook point)
- `packages/daemon/src/sessions/session-agent-turn.ts` (alternative hook point)

## Phase 3: Expose Parameter in Tool Descriptor and CLI

Add `delivery_mode` to the builtin-subagent tool schema and the CLI spawn command.

- Add `delivery_mode` property to `subagentToolArgs` in the tool descriptor
- Pass `delivery_mode` from tool handler args to the control plane payload
- Add `--delivery-mode` flag to CLI `subagent spawn` command
- Update CLI help text

**Files:**

- `packages/mcp-integration/src/builtin-shoggoth-tools.ts`
- `packages/daemon/src/sessions/builtin-handlers/session-handlers.ts`
- `packages/cli/src/run-subagent.ts`

## Phase 4: Tests

- Unit tests for `deliverSubagentResult()` covering all three modes and the inline fallback
- Unit test for max-char truncation
- Unit test for persistent all-turn delivery
- Integration test for end-to-end background one-shot with inline delivery
- Integration test for persistent subagent multi-turn delivery

**Files:**

- `packages/daemon/test/control/deliver-subagent-result.test.ts` (new)
- `packages/daemon/test/sessions/session-handlers-subagent.test.ts` (new or extended)
