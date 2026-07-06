# Implementation

## Phase 1: Schema and module

Add the new table and the helper module. Pure additive work; no callers
change yet.

- Create `migrations/0019_re_read_required.sql` with the schema from
  `spec.md`.
- Create `packages/daemon/src/sessions/re-read-required.ts` exporting
  `markReReadRequired`, `checkReReadRequired`, `clearReReadRequired`, and
  `clearSessionReReadRequired`.
- Create `packages/daemon/test/sessions/re-read-required.test.ts` covering
  all four helpers in isolation: insert, lookup, segment-scoping, clear,
  and session-wide clear.

**Files:**

- `migrations/0019_re_read_required.sql`
- `packages/daemon/src/sessions/re-read-required.ts`
- `packages/daemon/test/sessions/re-read-required.test.ts`

## Phase 2: Wire the producer into `builtin-replace`

Make `replace-handler.ts` flag the file when line numbers may have shifted.
Read the line count before the write and after the on-disk write; if the
counts differ, insert a re-read-required row.

`dryRun: true` must not flag. Zero-match returns (`replacements: 0`) must
not flag. The flag is added _after_ the on-disk write succeeds — if the
write fails, no row is inserted.

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/replace-handler.ts`
- `packages/daemon/test/builtin-handlers/replace-handler-reread.test.ts`

## Phase 3: Wire the consumers into `builtin-write` and `builtin-replace`

Make `fs-handlers.ts` (write) and `replace-handler.ts` (replace) check the
flag before applying. Return a `gated: true` payload if the flag is set.
`dryRun: true` is exempt.

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/fs-handlers.ts`
- `packages/daemon/src/sessions/builtin-handlers/replace-handler.ts`
- `packages/daemon/test/builtin-handlers/write-handler-reread.test.ts`
- `packages/daemon/test/builtin-handlers/replace-handler-reread.test.ts`

## Phase 4: Wire the clear into `builtin-read`

Make `fs-handlers.ts` (read) clear the flag for the current segment after
a successful content read. `stat`-only reads must not clear.

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/fs-handlers.ts`
- `packages/daemon/test/builtin-handlers/read-handler-reread.test.ts`

## Phase 5: Reset on context segment changes

Make `applySessionContextSegmentNew` and `applySessionContextSegmentReset`
call `clearSessionReReadRequired` for the session.

**Files:**

- `packages/daemon/src/sessions/session-context-segment.ts`
- `packages/daemon/test/sessions/session-context-segment-reread.test.ts`

## Phase 6: Type-check, lint, format, PR

- Run `npm run typecheck`.
- Run `npm run lint`.
- Run `npm run format`.
- Run the full test suite (`npm test`).
- Commit each phase as a focused commit.
- Push the branch and open a PR via `gh`.
