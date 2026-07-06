---
date: 2026-07-06
completed: never
---

# Re-Read Enforcement

## Summary

Adds a "re-read required" gate to the `builtin-read`, `builtin-write`, and
`builtin-replace` tools. After a `replace` operation that shifts line numbers,
the affected file is flagged. Subsequent `write` or `replace` calls against
that file fail until the agent re-reads it with `builtin-read`. The flag list
is scoped to the current `context_segment_id` and is emptied whenever a new
segment is generated.

## Motivation

Today, the agent can call `replace` with line numbers that are stale because
its model context holds a copy of the file from many turns ago. The `TOOLS.md`
guidance already warns against this, but there is no enforcement. The agent
occasionally misapplies edits and corrupts files, and the failure mode is
silent (or surfaces only when the file no longer parses).

By treating `replace` as the canonical "line numbers may have shifted" signal
and `read` as the cure, we make the rule mechanical rather than advisory.

## Design

The enforcement is implemented as a third gate alongside the existing
`AGENTS.md` gate. It uses a small new SQLite table keyed on
`(session_id, context_segment_id, file_path)`.

**Producer (`builtin-replace`):** After a successful non-dry-run modification,
compare the file's line count before and after. If the count changed (line
numbers may have shifted), insert a row with the current
`context_segment_id` and the canonical absolute path of the file. The
producer always runs _after_ a successful write to disk, so the new line
count reflects the on-disk state.

**Consumer (`builtin-write` and `builtin-replace`):** Before applying any
non-dry-run modification, look up `(session_id, current_segment_id, file_path)`.
If a row exists, return a gate result asking the agent to re-read the file.
`dryRun: true` is exempt — it is a preview, not a modification, and the
agent typically uses it precisely to figure out the right edit.

**Clear (`builtin-read`):** A successful read of the file deletes any matching
rows for the current segment. Reading just a portion of the file is
sufficient — the gate requires _some_ view of the new content.

**Segment reset:** `applySessionContextSegmentNew` and
`applySessionContextSegmentReset` delete all re-read rows for the session.
The new `context_segment_id` is naturally invisible to the old rows, but
deleting is the explicit form of "the list should be emptied" from the spec
and prevents the table from growing without bound across resets.

The canonical file key is the result of `resolveUserPath(ctx, path)` for the
tool's `path` argument. This is the workspace-rooted absolute path, which is
identical for `subdir/foo.txt`, `./subdir/foo.txt`, and the resolved form,
so the producer and consumer always agree on the key.

## Testing Strategy

Unit tests for the new module and integration tests for the gate behaviour:

- **`re-read-required.test.ts`** — pure unit tests for the helpers
  (`markReReadRequired`, `checkReReadRequired`, `clearReReadRequired`,
  `clearSessionReReadRequired`). Covers insert, lookup, no-match, idempotent
  clear, and the segment-scoping invariant.
- **`replace-handler-reread.test.ts`** — end-to-end tests through the
  `BuiltinToolRegistry`. Covers:
  - No flag → no effect on subsequent `write`/`replace`/`read`.
  - `replace` that adds lines → file is flagged.
  - `replace` whose replacement has the same line count → not flagged.
  - `replace` of zero matches → not flagged.
  - `dryRun: true` does not flag.
  - `deleteLines` always flags (file shrinks).
- **`write-handler-reread.test.ts`** — `write` is blocked when file is
  flagged; cleared by `read`.
- **`read-handler-reread.test.ts`** — `read` clears the flag for the
  current segment only; segment-bound behaviour.
- **`session-context-segment-reread.test.ts`** — `applySessionContextSegmentNew`
  and `applySessionContextSegmentReset` clear all rows for the session.

All tests follow the existing patterns in `packages/daemon/test/sessions/`
and `packages/daemon/test/builtin-handlers/`.

## Considerations

- **`dryRun: true` exemption.** The spec says the gate fires when the file
  "would be modified". A dry run is a preview, not a modification, and
  intentionally lets the agent _check_ the current state without committing.
  The producer also skips flagging on dry runs.
- **Pattern-based replacement and line count.** A regex replacement can
  change the line count (e.g. inserting/removing `\n`) even when the user
  does not specify line numbers. We track this by comparing the line count
  of the file before and after the write. This is a conservative, correct
  signal: if the line count is unchanged, line numbers are preserved.
- **File created from scratch by `write`.** A `write` to a path that does
  not exist is not in the flag list (no prior content means no prior line
  numbers), so it is not blocked. After a `write` of a brand-new file, the
  file is _not_ flagged (the spec says only `replace` adds to the list).
  A subsequent `replace` will succeed without re-reading, which is the
  intended behaviour: there were no line numbers to invalidate.
- **Append mode.** `write` with `append: true` adds to the end of the file
  and shifts all subsequent line numbers. We treat appends as a "would be
  modified" case and gate them if the file is flagged. This is the
  conservative choice and matches the spirit of the spec.
- **Image reads.** A `read` of an image file still clears the flag for that
  path. The agent has viewed the file (even if not as text), and that is
  sufficient to know the new state.
- **Symlinks and `realpath`.** The key is `resolveUserPath` (logical
  workspace-rooted path), not the realpath. Two different symlinks to the
  same file are treated as the same file. This matches the user's mental
  model of "the file at this path".

## Migration

A new migration `migrations/0019_re_read_required.sql` creates the table.
Existing sessions have no rows, so no backfill is needed. The table is
session-scoped and rows are deleted on segment reset, so it does not grow
unbounded.

## References

- [`spec.md`](spec.md) — type signatures, table schema, code examples
- [`implementation.md`](implementation.md) — phased implementation steps
