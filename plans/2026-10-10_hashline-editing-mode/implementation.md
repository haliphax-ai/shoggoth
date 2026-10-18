# Implementation

Each phase is independently shippable and testable; additive work precedes integration.
TDD (red/green) per project rules. Phases 1–3 are runtime-invisible (`fileEditing` defaults
to `line-number`); phases 4–6 activate the mode behind the config key.

## Phase 1: Hashline core module (pure)

- New `packages/daemon/src/sessions/hashline/` module: `canonLine` for display anchors only,
  `allocateAnchors`, exact-content `lineChecksum`, duplicate/context `lineIdentityChecksum`,
  `contentChecksum`, `resolveAnchors`, `assertRangeServed`, `applySpan`/`changedRange`, stale
  error classes with fresh rows, and size-limit constants. Separate lossy display
  canonicalization from full-content verification.
- Unit tests cover deterministic snapshot allocation, collision probing, duplicate occurrence
  ambiguity, Unicode-safe byte caps, trailing-whitespace and over-cap-suffix changes, EOL
  parsing, upstream insert/delete/reorder, stale/range-stale behavior, no-op, and reversed bounds.

**Files:**

- `packages/daemon/src/sessions/hashline/{anchors,verify,apply,index}.ts`
- `packages/daemon/test/sessions/hashline/*.test.ts`

## Phase 2: State tables and boot id

- Migrations `0024_served_hashes.sql`, `0025_file_edit_mode_hint.sql` (the current tree has
  migrations through `0023_exec_notifies.sql`; recheck before implementation and never reuse a
  migration version).
- Served-map store module (register on read, lookup on replace, clear on segment
  new/reset — hook next to `clearSessionReReadRequired` in `session-context-segment.ts`).
- Daemon `bootId` (module-level `randomUUID()` at process start, exposed via a small
  runtime accessor) and hint-state helpers (`shouldHint`, `upsertHint`).

**Files:**

- `migrations/0024_served_hashes.sql`, `migrations/0025_file_edit_mode_hint.sql`
- `packages/daemon/src/sessions/hashline/served-store.ts`
- `packages/daemon/src/sessions/hashline/hint-state.ts`
- `packages/daemon/src/sessions/session-context-segment.ts` (segment clear hook)
- Session deletion/retirement path(s) (served-row cleanup)
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

## Phase 4: builtin-read hashline mode and catalog plumbing

- Resolve the mode/schema boundary explicitly: pass immutable `FileEditingContext` into
  `builtinShoggothToolsCatalog`/`buildAggregatedMcpCatalog` and thread it through every
  session/tool-context construction and tool-call handler context. Do not assume catalogs are
  rebuilt per turn; test each builder and runtime path. Keep catalog and handler mode identical.
- Hashline mode changes the replace schema's `start`/`end` and batch-item types. Specify the
  read API separately: preserve existing `fromLine`/`toLine`/`offset`/`limit` window selection;
  document returned row format and stable line numbering in the result. Keep `lines` and
  `lineNumbers` behavior explicit rather than requiring callers to guess an option.
- Define behavior for each read result kind: full/ranged text, multi-file, truncation, stat,
  image, empty file, and too-large file. Register only text rows actually emitted to the model;
  never register truncated-away rows, stats, notices, or image data. If an existing result shape
  cannot safely identify rows returned, adapt it or reject that combination in hashline mode.
- Prefix returned text rows with anchors, register exact row checksums plus duplicate identity
  metadata, and use one normalized workspace-relative path representation for registration and
  replace lookup. Leave line-number mode unchanged.
- Tests cover every result kind, clipping/truncation boundaries, file-size caps, and mode/schema
  parity across catalog construction and invocation.

**Files:**

- `packages/mcp-integration/src/builtin-shoggoth-tools.ts`
- `packages/daemon/src/mcp/tool-loop-mcp.ts`
- `packages/daemon/src/sessions/session-mcp-tool-context.ts`
- `packages/daemon/src/sessions/builtin-tool-registry.ts` and tool-context assembly in
  `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/src/sessions/builtin-handlers/fs-handlers.ts`
- `packages/daemon/test/sessions/builtin-handlers/read-hashline.test.ts`

## Phase 5: builtin-replace hashline mode

- Resolve anchors and validate each edit against the exact line checksum, duplicate ordinal,
  and local identity fingerprint registered by read. Verify every destructive row, including
  every line deleted; reject absent/unserved anchors, ambiguous duplicate resolution, and
  newly inserted interior content with fresh rows. Regex/fixed-string matches must be wholly
  served and verified before replacement; reject or precisely define multiline matches whose
  span cannot be mapped to complete served rows.
- Serialize read/verify/write through a per-canonical-path lock shared by hashline replace
  calls. Recheck the snapshot immediately before an atomic replacement. State that this only
  prevents races among cooperating handlers; cover other Shoggoth mutation paths or explicitly
  bound the guarantee to `builtin-replace`, and document the residual race from external writers.
- Preserve untouched original EOL separators and final-newline state; specify separator choice
  for inserted rows. Compute `live_anchors` and changed rows from the post-write file, never
  from pre-edit arrays. No-op edits must not write or invalidate served state.
- Skip the `re-read-required` consumer/producer in hashline replace only; do not imply the proof
  covers `builtin-write`, `builtin-exec`, or external writers unless integrated separately.
- `[E_FILE_TOO_LARGE]` guard for over-cap files. Handler tests cover concurrent edits, duplicate
  insertion/deletion, trailing-whitespace-only changes, changed suffix after hash cap, interior
  insertion during deletion, multiline regex, no-op, and post-write live rows; line-number tests
  stay green.

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/replace-handler.ts`
- Shared canonical-path file lock helper (add a dedicated file under `packages/daemon/src/sessions/`;
  exact module name to be chosen with existing filesystem helpers)
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
