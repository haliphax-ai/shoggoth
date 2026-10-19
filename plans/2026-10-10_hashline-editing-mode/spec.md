# Specification

## Interfaces

```ts
/** Config subtree; default mode is "line-number". Restart-required key. */
interface FileEditingConfig {
  /** Which dialect the builtin file tools speak. */
  mode: "line-number" | "hashline";
}

/** Resolved once per daemon boot; threaded into tool schema building and handlers. */
interface FileEditingContext {
  readonly mode: NonNullable<FileEditingConfig["mode"]>;
  /** Random UUID generated at daemon process start; drives the restart hint. */
  readonly bootId: string;
}

/** Per-line canonicalization before hashing. */
function canonLine(line: string): string; // display-anchor input only; normalize EOL, trimEnd, cap UTF-8 bytes

/** Deterministic compact display anchors for an exact file snapshot. */
function allocateAnchors(content: string): string[];

/** Verification checksum over complete decoded line content, including trailing spaces. */
function lineChecksum(line: string): string; // hex sha1 over exact UTF-8 bytes, excluding EOL separator

/** Fingerprint binding a row to its duplicate occurrence and local snapshot context. */
function lineIdentityChecksum(lines: readonly string[], index: number): string;

/** Whole-file cache key. */
function contentChecksum(content: string): string; // hex sha1 of raw content

/** Resolve anchor pairs against the CURRENT file content. */
function resolveAnchors(
  fileHashes: readonly string[],
  from: string,
  to: string,
): { fromLine: number; toLine: number } | AnchorResolutionError;

/** Verify served checksums across a resolved range. */
function assertRangeServed(input: {
  fileLines: readonly string[];
  fileHashes: readonly string[];
  fromLine: number;
  toLine: number;
  served: ReadonlyMap<
    string,
    { lineChecksum: string; identityChecksum: string; lineOrdinal: number }
  >;
  deletion: boolean; // retained for diagnostics; ALL destructive ranges verify every covered row
}): void; // throws RangeStaleError with fresh rows embedded
```

## Anchors

- **Input:** `canonLine(line)` = strip `\r`, `trimEnd()`, truncate to
  `MAX_HASH_SOURCE_BYTES` (8192) UTF-8 bytes.
- **Candidate derivation:** `base32(sha1(`${canon}\u0000${salt}`)).slice(0, 6)` for
  `salt = 0, 1, 2, …`, where base32 is the RFC 4648 alphabet `A-Z2-7`. First salt whose
  6-char candidate is unused in the file wins.
- **Properties:** 6 chars × 5 bits = 30-bit space; per-file collisions resolved by salt
  probe; allocation is deterministic for an exact file snapshot. Anchors are not globally
  stable line identities: inserting/removing duplicate canonical lines can change collision
  assignments. The served map therefore also records occurrence ordinal and a neighboring-line
  identity fingerprint; if resolution points at a different occurrence/context, reject with
  `[E_STALE_ANCHOR]` and fresh rows rather than guessing. Anchor pattern: `^[A-Z2-7]{6}$`.
- **Caps:** `MAX_HASHLINE_LINES` = 65536; files over the cap are rejected in hashline mode
  with an error directing the agent to `builtin-write`.

## Data Structures / Schemas

### `served_hashes` (migration `0024_served_hashes.sql`)

Migration numbering follows the current repository sequence: existing migrations run through
`0023_exec_notifies.sql`; do not reuse earlier numbers. Assign additional migrations after
`0024` only after checking the tree and migration runner for newer entries.

```sql
CREATE TABLE IF NOT EXISTS served_hashes (
  session_id         TEXT    NOT NULL,
  context_segment_id TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,
  anchor             TEXT    NOT NULL,
  line_checksum      TEXT    NOT NULL, -- exact line content, excluding its EOL separator
  identity_checksum  TEXT    NOT NULL, -- line + neighboring-line context fingerprint
  line_ordinal       INTEGER NOT NULL, -- 1-based occurrence among identical canonical lines
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, context_segment_id, file_path, anchor)
);
CREATE INDEX IF NOT EXISTS served_hashes_session_idx
  ON served_hashes (session_id, context_segment_id);
```

Paths are normalized using the same workspace-relative canonical form at read and replace.
Only rows actually rendered to the model are registered; truncated-away rows, notices,
metadata, and image payloads do not count as served. Clear rows on context segment new/reset
and on session deletion/retirement so state is not retained indefinitely. Verification must
fail closed if an anchor now resolves to a different duplicate occurrence or its identity
fingerprint has changed.

`file_edit_mode_hint` uses migration `0025_file_edit_mode_hint.sql` (same migration-numbering
rule). The hint table is session-scoped and is not a substitute for served-row cleanup.

### `file_edit_mode_hint`

```sql
CREATE TABLE IF NOT EXISTS file_edit_mode_hint (
  session_id          TEXT    PRIMARY KEY,
  last_hinted_boot_id TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Emission rule: hint when the row is missing (first turn of session) or
`last_hinted_boot_id != currentBootId` (first turn after restart); then upsert.

### `builtin-replace` — hashline value semantics (names unchanged)

```jsonc
// Positional (mode: "hashline"); examples conform to the RFC 4648 A-Z2-7 alphabet.
{ "path": "projects/x.ts", "start": "XK7QM2", "end": "AB3ZZ7", "replacement": "new line" }
// Batch (mode: "hashline"); same shape as line-number mode, with anchor strings.
{ "path": "projects/x.ts", "edits": [
  { "start": "XK7QM2", "end": "AB3ZZ7", "replacement": "..." } // omitted => delete
] }
```

Rendered schema differences per mode (single source, mode-selected at build time):

| Field         | line-number mode         | hashline mode                                |
| ------------- | ------------------------ | -------------------------------------------- |
| `start`/`end` | `type: "integer"`, min 1 | `type: "string"`, `pattern: "^[A-Z2-7]{6}$"` |
| descriptions  | "1-based line numbers"   | "content anchors served by builtin-read"     |

### Error payloads

Examples use only uppercase RFC 4648 base32 characters `A-Z2-7`, matching the schema
pattern. Anchors are not case-insensitive; reject malformed/lowercase values rather than
silently normalizing them.

```jsonc
// [E_STALE_ANCHOR] — absent anchor or ambiguous duplicate identity; fresh rows supplied
{ "error": "[E_STALE_ANCHOR] Anchor XK7QM2 is stale in <path>. Current rows include 41: QW3RT7│...",
  "fresh": { "lines": [ { "line": 41, "anchor": "QW3RT7", "text": "..." } ] } }

// [E_RANGE_STALE] — any covered row is unserved or its exact content/identity changed
{ "error": "[E_RANGE_STALE] Lines 40-52 of <path> no longer match what you read...",
  "fresh": { "lines": [ { "line": 40, "anchor": "MM2KK4", "text": "..." } ] } }

// [E_FILE_TOO_LARGE] — over MAX_HASHLINE_LINES in hashline mode
{ "error": "[E_FILE_TOO_LARGE] <path> exceeds the 65536-line hashline limit; use builtin-write." }
```

### Result payload addition (hashline mode, successful edit)

```jsonc
{
  "changed_lines": { "start": 40, "end": 52 },
  "live_anchors": "MM2KK4│const x = 1;\nPP7LL2│const y = 2;",
} // +anchor rows for the changed window
```

### System-prompt hint block

Always-on marker (runtime summary part): `file_edit=hashline` (or `line-number`).

Conditional block text (hashline; line-number variant mirrors today's documented behavior):

```
File editing mode: hashline. builtin-read prefixes each line with a content anchor
(`XXXXXX│text`) and remembers what it served you. builtin-replace `start`/`end` are
anchor strings, not line numbers. If the content under an anchor changed since your
read, the call fails with fresh anchors for the affected lines — retry with those
instead of re-reading. Successful edits return live anchors for the changed window.
```

## Code Examples

For line splitting, retain each original separator and the file's final-newline state. New
replacement rows inherit the first replaced row's separator; insertions with no replaced row
inherit the nearest preceding separator, then the nearest following separator, falling back to
`\\n` for a file with no existing separator. Untouched bytes must remain unchanged.

```ts
// Hashline positional replace; serialized read/verify/write per canonical path.
await withFileEditLock(canonicalPath, async () => {
  const content = await readFileExact(absPath);
  const fileLines = splitLinesPreservingSeparators(content);
  const fileHashes = allocateAnchors(content);
  const range = resolveAnchors(fileHashes, args.start, args.end);
  assertRangeServed({ fileLines, fileHashes, ...range, served, deletion: !replacement });
  const next = applySpan(content, fileLines, range, replacement);
  if (next === content) return noOpResult();
  // Recheck snapshot identity immediately before atomic replacement; lock also
  // serializes cooperating handlers for this path.
  await assertUnchangedSinceRead(absPath, contentChecksum(content));
  await atomicReplaceFile(absPath, next);
  const liveLines = splitLinesPreservingSeparators(next);
  const liveHashes = allocateAnchors(next);
  return resultWithLiveRows(liveLines, liveHashes, changedRange(content, next));
});
```

The lock only coordinates Shoggoth file-edit handlers. Non-cooperating external writers
cannot be made race-free with a check-then-rename protocol; re-stat/re-read immediately
before commit and document the residual race unless the filesystem provides an actual
compare-and-swap primitive. `builtin-write`, `builtin-exec`, and other writers are outside
the hashline replace guarantee unless separately routed through this locking/verification
layer.

```ts
// Hint emission (session-system-prompt assembly)
const bootId = getBootId(); // module-level randomUUID at daemon start
if (shouldHint(db, sessionId, bootId)) {
  // row missing or boot mismatch
  prompt += daemonPrompt("system-file-edit-mode-hint", { mode });
  upsertHint(db, sessionId, bootId);
}
```
