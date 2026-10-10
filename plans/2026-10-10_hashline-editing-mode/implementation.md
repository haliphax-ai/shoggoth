# Implementation

Each phase is independently shippable and testable; additive work precedes integration.
TDD (red/green) per project rules. Phases 1–3 are runtime-invisible (`fileEditing` defaults
to `line-number`); phases 4–6 activate the mode behind the config key.

## Phase 1: Hashline core module (pure)

- New `packages/daemon/src/sessions/hashline/` module: `canonLine`, `allocateAnchors`,
  `lineChecksum`, `contentChecksum`, `resolveAnchors`, `assertRangeServed`,
  `applySpan`/`changedRange` helpers, error classes (`AnchorStaleError`, `RangeStaleError`)
  with `fresh` row payloads, and constants (`MAX_HASH_SOURCE_BYTES`, `MAX_HASHLINE_LINES`).
- Full unit-test suite for allocation determinism, collision probing, resolution under
  upstream edits, stale/range-stale detection, no-op and reversed-bound handling.

**Files:**

- `packages/daemon/src/sessions/hashline/{anchors,verify,apply,index}.ts`
- `packages/daemon/test/sessions/hashline/*.test.ts`

## Phase 2: State tables and boot id

- Migrations `0021_served_hashes.sql`, `0022_file_edit_mode_hint.sql`.
- Served-map store module (register on read, lookup on replace, clear on segment
  new/reset — hook next to `clearSessionReReadRequired` in `session-context-segment.ts`).
- Daemon `bootId` (module-level `randomUUID()` at process start, exposed via a small
  runtime accessor) and hint-state helpers (`shouldHint`, `upsertHint`).

**Files:**

- `migrations/0021_served_hashes.sql`, `migrations/0022_file_edit_mode_hint.sql`
- `packages/daemon/src/sessions/hashline/served-store.ts`
- `packages/daemon/src/sessions/hashline/hint-state.ts`
- `packages/daemon/src/sessions/session-context-segment.ts` (clear hook)
- `packages/daemon/test/sessions/hashline/served-store.test.ts`,
  `packages/daemon/test/sessions/hashline/hint-state.test.ts`

## Phase 3: Config plumbing

- `fileEditing: { mode }` in `@shoggoth/shared` config schema (default `line-number`).
- Add `"fileEditing"` to `CONFIG_RESTART_REQUIRED_KEYS`.
- Effective-config accessor returning `FileEditingContext` (mode + bootId).

**Files:**

- `packages/shared/src/config.ts` (or equivalent schema module)
- `packages/daemon/src/config-policy.ts`
- `packages/daemon/src/config/effective-runtime.ts`
- `packages/daemon/test/config/file-editing-config.test.ts`

## Phase 4: builtin-read hashline mode

- Schema/description rendering in `builtin-shoggoth-tools.ts`: mode-conditional `start`/`end`
  types and descriptions (names unchanged); `builtin-read` description gains anchor-format
  guidance in hashline mode. Verify how the schema builder learns the effective mode (main
  integration unknown — resolve here; config is plumbable since the daemon builds tool
  contexts per turn).
- Read handler: in hashline mode, prefix output rows with anchors and register the served
  map for the returned window.
- Line-number mode path untouched; existing read tests stay green.

**Files:**

- `packages/mcp-integration/src/builtin-shoggoth-tools.ts`
- `packages/daemon/src/sessions/builtin-handlers/` (read handler)
- `packages/daemon/test/sessions/builtin-handlers/read-hashline.test.ts`

## Phase 5: builtin-replace hashline mode

- Mode branch in `replaceHandler`: interpret `start`/`end` (and `edits[]` items) as anchors;
  resolve + verify via the hashline core; write via existing span mechanics; return
  `changed_lines` + `live_anchors`; no-op short-circuit; `[W_*]` slip-stripping; regex mode
  gains served-checksum verification of matched lines under hashline mode.
- Skip the `re-read-required` consumer/producer in hashline mode only.
- `[E_FILE_TOO_LARGE]` guard for over-cap files.
- Handler integration tests for every mode×feature combination; line-number regression suite
  stays green.

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/replace-handler.ts`
- `packages/daemon/test/sessions/builtin-handlers/replace-hashline.test.ts`

## Phase 6: System-prompt mode hint

- `file_edit=<mode>` marker in `buildRuntimeSection` parts.
- Conditional hint block via new `system-file-edit-mode-hint` prompt template, gated by
  `shouldHint`/`upsertHint` (first turn of session; first turn after each restart).
- Tests: emission on session first turn, re-emission on boot-id change, no repeat within a
  boot, correct template per mode.

**Files:**

- `packages/daemon/src/sessions/session-system-prompt.ts`
- `packages/daemon/src/prompts/system-file-edit-mode-hint.md`
- `packages/daemon/test/sessions/session-system-prompt-hint.test.ts`

## Phase 7: Docs and cleanup

- Runbook entry for switching modes; document the restart requirement.
- Knip pass (no dead exports from the new module); final oxlint/oxfmt/tsc green.

**Files:**

- `docs/runbook.md`
- (touch-ups as flagged by knip)
