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
function canonLine(line: string): string; // strip \r, trimEnd, cap at MAX_HASH_SOURCE_BYTES

/** Deterministic per-file anchor allocation. Pure: (content) -> anchors. */
function allocateAnchors(content: string): string[];

/** Per-line served checksum (content proof). */
function lineChecksum(line: string): string; // hex sha1 of canonLine(line)

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
  served: ReadonlyMap<string, string>; // anchor -> checksum served to this session
  deletion: boolean; // deletions enforce only boundary lines
}): void; // throws RangeStaleError with fresh rows embedded
```

## Anchors

- **Input:** `canonLine(line)` = strip `\r`, `trimEnd()`, truncate to
  `MAX_HASH_SOURCE_BYTES` (8192) UTF-8 bytes.
- **Candidate derivation:** `base32(sha1(`${canon}\u0000${salt}`)).slice(0, 6)` for
  `salt = 0, 1, 2, …`, where base32 is the RFC 4648 alphabet `A-Z2-7`. First salt whose
  6-char candidate is unused in the file wins.
- **Properties:** 6 chars × 5 bits = 30-bit space; per-file collisions resolved by salt
  probe; allocation is a pure function of file content — deterministic across sessions,
  machines, and restarts. Anchor pattern: `^[A-Z2-7]{6}$`.
- **Caps:** `MAX_HASHLINE_LINES` = 65536; files over the cap are rejected in hashline mode
  with an error directing the agent to `builtin-write`.

## Data Structures / Schemas

### `served_hashes` (migration `0021_served_hashes.sql`)

```sql
CREATE TABLE IF NOT EXISTS served_hashes (
  session_id         TEXT    NOT NULL,
  context_segment_id TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,
  anchor             TEXT    NOT NULL,
  line_checksum      TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, context_segment_id, file_path, anchor)
);
CREATE INDEX IF NOT EXISTS served_hashes_session_idx
  ON served_hashes (session_id, context_segment_id);
```

Cleared on context segment new/reset alongside `re_read_required`
(`session-context-segment.ts`).

### `file_edit_mode_hint` (migration `0022_file_edit_mode_hint.sql`)

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
// positional (mode: "hashline")
{ "path": "projects/x.ts", "start": "Xk7Qm2", "end": "Ab3Zz9", "replacement": ["new line"] }
// batch (mode: "hashline") — same shape as line-number mode
{ "path": "projects/x.ts", "edits": [
  { "start": "Xk7Qm2", "end": "Ab3Zz9", "replacement": ["..."] } // replacement omitted => delete
] }
```

Rendered schema differences per mode (single source, mode-selected at build time):

| Field         | line-number mode         | hashline mode                                |
| ------------- | ------------------------ | -------------------------------------------- |
| `start`/`end` | `type: "integer"`, min 1 | `type: "string"`, `pattern: "^[A-Z2-7]{6}$"` |
| descriptions  | "1-based line numbers"   | "content anchors served by builtin-read"     |

### Error payloads

```jsonc
// [E_STALE_ANCHOR] — anchor absent from current file; embeds fresh rows around the
// surviving bound so the agent can retry without a re-read
{ "error": "[E_STALE_ANCHOR] \"Xk7Qm2\" is not in <path> as read. Current rows:\n  41: Qw3Rt8│...",
  "fresh": { "lines": [ { "line": 41, "anchor": "Qw3Rt8", "text": "..." } ] } }

// [E_RANGE_STALE] — range resolved but served checksums mismatch; embeds fresh range
{ "error": "[E_RANGE_STALE] Lines 40-52 of <path> no longer match what you read...",
  "fresh": { "lines": [ { "line": 40, "anchor": "Mm2Kk4", "text": "..." } ] } }

// [E_FILE_TOO_LARGE] — over MAX_HASHLINE_LINES in hashline mode
{ "error": "[E_FILE_TOO_LARGE] <path> exceeds the 65536-line hashline limit; use builtin-write." }
```

### Result payload addition (hashline mode, successful edit)

```jsonc
{
  "changed_lines": { "start": 40, "end": 52 },
  "live_anchors": "Mm2Kk4│const x = 1;\nPp9Ll0│const y = 2;",
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

```ts
// Handler-level hashline replace (inside replaceHandler, mode branch)
const fileHashes = allocateAnchors(content);
const range = resolveAnchors(fileHashes, args.start, args.end); // -> E_STALE_ANCHOR on miss
assertRangeServed({ fileLines, fileHashes, ...range, served, deletion: !replacement });
const next = applySpan(content, fileLines, range, replacement); // no-op short-circuit
writeFileSync(absPath, next, "utf8");
return {
  resultJson: JSON.stringify({
    changed_lines: changedRange(content, next),
    live_anchors: fmtRows(fileHashes, fileLines, changedRange(content, next)),
  }),
};
```

```ts
// Hint emission (session-system-prompt assembly)
const bootId = getBootId(); // module-level randomUUID at daemon start
if (shouldHint(db, sessionId, bootId)) {
  // row missing or boot mismatch
  prompt += daemonPrompt("system-file-edit-mode-hint", { mode });
  upsertHint(db, sessionId, bootId);
}
```
