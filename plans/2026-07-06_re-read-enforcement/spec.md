# Specification

## Interfaces

The new module exposes a small set of functions that operate on a
`better-sqlite3` `Database` handle. The `BuiltinToolContext` is unchanged —
handlers continue to receive the `db` and `sessionId` they already have.

```ts
// packages/daemon/src/sessions/re-read-required.ts

export interface ReReadRequiredGate {
  readonly gated: true;
  readonly message: string;
  readonly filePath: string;
}

/**
 * Mark `filePath` as needing a re-read for the current context segment.
 * Called by `builtin-replace` after a successful non-dry-run modification
 * that may have shifted line numbers.
 */
export function markReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): void;

/**
 * Check whether `filePath` is flagged for re-read in the current segment.
 * Returns a gate result if blocked, `null` otherwise.
 */
export function checkReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): ReReadRequiredGate | null;

/**
 * Clear the re-read flag for `filePath` in the current segment.
 * Called by `builtin-read` after a successful read of the file.
 */
export function clearReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): void;

/**
 * Clear all re-read flags for a session across all segments.
 * Called when a new context segment is generated (or reset).
 */
export function clearSessionReReadRequired(
  db: Database.Database,
  sessionId: string,
): void;
```

## Data Structures / Schemas

Migration `migrations/0019_re_read_required.sql`:

```sql
CREATE TABLE IF NOT EXISTS re_read_required (
  session_id         TEXT    NOT NULL,
  context_segment_id TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, context_segment_id, file_path)
);

CREATE INDEX IF NOT EXISTS re_read_required_session_idx
  ON re_read_required (session_id);
```

The `created_at` column is informational; the gate does not depend on it.

## Code Examples

### Producer (replace-handler.ts)

After a successful non-dry-run write to disk:

```ts
const before = readFileSync(absPath, "utf8");
const beforeLines = before.split(/\r\n|\n|\r/).length;
// ... apply edit ...
const after = readFileSync(absPath, "utf8");
const afterLines = after.split(/\r\n|\n|\r/).length;
if (afterLines !== beforeLines) {
  const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
  markReReadRequired(ctx.db, ctx.sessionId, segmentId, canonicalPath);
}
```

### Consumer (write-handler.ts / replace-handler.ts)

At the top of the handler, before any modification:

```ts
const canonicalPath = resolveUserPath(ctx, path);
const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
const gate = checkReReadRequired(ctx.db, ctx.sessionId, segmentId, canonicalPath);
if (gate) return { resultJson: JSON.stringify(gate) };
```

`dryRun: true` is exempt from this check.

### Clear (read-handler.ts)

After a successful read of a file:

```ts
const canonicalPath = resolveUserPath(ctx, path);
const segmentId = getSessionContextSegmentId(ctx.db, ctx.sessionId);
clearReReadRequired(ctx.db, ctx.sessionId, segmentId, canonicalPath);
```

`stat`-only reads (`stat: true`, `paths: [...]` for `stat-multi`) do not
clear the flag because no content was viewed.

### Gate result

```json
{
  "gated": true,
  "message": "File has changed since you last read it. Re-read the file (or the relevant section) with `builtin-read` and retry your edit. After reading, line numbers in your context will be valid again.",
  "filePath": "src/example.ts"
}
```

The shape mirrors the `AGENTS.md` gate (`gated: true` plus a human-readable
`message`) so the model has a consistent signal for "stop and read this
first" situations.
