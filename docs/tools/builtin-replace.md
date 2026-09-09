# builtin-replace

Replace patterns in files with support for regex replacements, positional line-level edits, and dry-run mode. Provides safety warnings for large numbers of replacements and preserves line endings.

## Parameters

| Param            | Type                                  | Required | Notes                                                                                                                                       |
| ---------------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`           | string                                | yes      | Workspace-relative path to the file to modify                                                                                               |
| `start`          | number                                | no       | Start line number (1-indexed). Use with `end` for a single positional edit.                                                                 |
| `end`            | number                                | no       | End line number (1-indexed, inclusive). Use with `start` for a single positional edit.                                                      |
| `replacement`    | string                                | no       | Replacement text. For regex: supports `$1`–`$9` capture groups. For positional: content to insert. Omit with `start`/`end` to delete lines. |
| `pattern`        | string                                | no       | Regex pattern to match (required for regex replacement mode)                                                                                |
| `caseSensitive`  | boolean                               | no       | Set `false` for case-insensitive (default: true)                                                                                            |
| `maxOccurrences` | number                                | no       | Maximum number of replacements to make (default: unlimited)                                                                                 |
| `dryRun`         | boolean                               | no       | Preview changes without modifying file (default: false)                                                                                     |
| `fixedStrings`   | boolean                               | no       | Treat pattern as a literal string, not regex (default: false)                                                                               |
| `multiline`      | boolean                               | no       | Enable multiline mode (`m` flag) for regex patterns (default: false)                                                                        |
| `edits`          | array of `{start, end, replacement?}` | no       | Apply multiple positional edits in a single call (see Batch Edits mode)                                                                     |

## Operation Modes

The three modes — **positional edits**, **batch edits**, and **regex** — are mutually exclusive.

### 1. Positional Edit (single)

Replace or delete a contiguous range of lines using `start` and `end`. If `replacement` is provided, the range is replaced; if absent, the range is deleted.

```json
// Delete lines 10 through 20
{ "path": "src/foo.ts", "start": 10, "end": 20 }

// Replace lines 10 through 15 with new content
{
  "path": "src/foo.ts",
  "start": 10,
  "end": 15,
  "replacement": "new content"
}
```

### 2. Regex Replacement

Replace text matching a regex pattern:

```json
{
  "path": "src/foo.ts",
  "pattern": "oldName",
  "replacement": "newName"
}
```

### 3. Literal (fixedStrings) Replacement

Replace text matching a literal string — no regex escaping needed:

```json
{
  "path": "src/foo.ts",
  "pattern": "fn(arg1, arg2)",
  "replacement": "fn(arg1, arg2, arg3)",
  "fixedStrings": true
}
```

### 4. Batch Edits

Apply multiple positional edits to a file in a single tool call. All line numbers reference the **original file** (before any edits are applied). Edits are sorted internally by highest line number first (bottom-up) to prevent line-shifting corruption.

`edits` is **mutually exclusive** with `pattern` and `start`/`end`.

Each edit object uses the normalized format `{ start, end, replacement? }`:

- **Replace:** include `replacement` to replace lines `start..end` with that content
- **Delete:** omit `replacement` to delete lines `start..end`

#### Batch example — two non-overlapping replaces

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "start": 2, "end": 3, "replacement": "new lines 2-3" },
    { "start": 10, "end": 12, "replacement": "new lines 10-12" }
  ]
}
```

#### Batch example — mixed replace and delete

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "start": 5, "end": 7, "replacement": "replaced block" },
    { "start": 20, "end": 20 }
  ]
}
```

#### Batch with dry run

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "start": 1, "end": 3, "replacement": "header" },
    { "start": 50, "end": 60 }
  ],
  "dryRun": true
}
```

**Constraints:**

- Maximum 50 edits per call
- Edits must not have overlapping line ranges (returns an error)
- All line numbers must be within the original file bounds
- Empty `edits` array is rejected

**Why batch edits?**

Lower-cost LLMs frequently mangle files when making successive edits in a single turn because each edit shifts line numbers for subsequent edits. Batch edits solve this by having all edits reference the original file state and applying them bottom-up automatically.

## Dry Run Mode

When `dryRun: true` is specified, the tool returns a preview of changes without modifying the file:

**Positional edit preview:**

```json
{
  "success": true,
  "edits_applied": 1,
  "preview": "line1\nnew content\nline4\nline5"
}
```

**Regex replacement preview:**

```json
{
  "replacements": 3,
  "changed_lines": [{ "line": 1 }, { "line": 3 }, { "line": 5 }],
  "preview": "new content for line 1\n..."
}
```

## Return Value Structure

### Positional / Batch Edits

```json
{
  "success": true,
  "edits_applied": 3
}
```

For single positional edits, `changed_lines` is also included:

```json
{
  "success": true,
  "edits_applied": 1,
  "changed_lines": [
    { "start": 2, "end": 6 },
    { "start": 7, "end": 9 }
  ]
}
```

### Regex / fixedStrings

```json
{
  "replacements": 2,
  "changed_lines": [{ "line": 1 }, { "line": 3 }]
}
```

### Error

```json
{
  "error": "edits contain overlapping line ranges"
}
```

## Examples

### Positional Edit Examples

**Delete a single line:**

```json
{ "path": "src/foo.ts", "start": 42, "end": 42 }
```

**Delete a range:**

```json
{ "path": "src/foo.ts", "start": 10, "end": 20 }
```

**Replace a range with a single string:**

```json
{
  "path": "src/foo.ts",
  "start": 10,
  "end": 15,
  "replacement": "// Updated section"
}
```

**Replace a range with multiple lines:**

```json
{
  "path": "src/foo.ts",
  "start": 10,
  "end": 12,
  "replacement": "line 1\nline 2\nline 3"
}
```

### Regex Replacement Examples

**Basic replacement:**

```json
{
  "path": "src/foo.ts",
  "pattern": "oldName",
  "replacement": "newName"
}
```

**Regex with capture groups:**

```json
{
  "path": "src/foo.ts",
  "pattern": "fn_(\\w+)",
  "replacement": "func_$1"
}
```

**Case-insensitive replacement:**

```json
{
  "path": "src/foo.ts",
  "pattern": "TODO",
  "replacement": "FIXME",
  "caseSensitive": false
}
```

**Limit number of replacements:**

```json
{
  "path": "src/foo.ts",
  "pattern": "foo",
  "replacement": "bar",
  "maxOccurrences": 2
}
```

**Preview changes with dry run:**

```json
{
  "path": "src/foo.ts",
  "pattern": "old",
  "replacement": "new",
  "dryRun": true
}
```

### Literal (fixedStrings) Examples

**Replace literal text with regex metacharacters — no escaping needed:**

```json
{
  "path": "src/foo.ts",
  "pattern": "(bar) [baz]",
  "replacement": "replaced",
  "fixedStrings": true
}
```

**Multiline literal replace:**

```json
{
  "path": "src/foo.ts",
  "pattern": "if (old) {\n  return false;\n}",
  "replacement": "if (updated) {\n  return true;\n}",
  "fixedStrings": true,
  "multiline": true
}
```

### Batch Edit Examples

**Delete two non-contiguous lines:**

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "start": 10, "end": 10 },
    { "start": 30, "end": 30 }
  ]
}
```

**Replace two ranges and delete another:**

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "start": 5, "end": 7, "replacement": "replaced block" },
    { "start": 20, "end": 25, "replacement": "new block" },
    { "start": 50, "end": 55 }
  ]
}
```

### Multiline Examples

**Multiline regex replace:**

```json
{
  "path": "src/foo.ts",
  "pattern": "// BEGIN BLOCK\\n[\\s\\S]*?// END BLOCK",
  "replacement": "// cleaned",
  "multiline": true
}
```

## Safety Warnings

### Large Replacement Count

When more than 1000 matches are detected:

- The tool returns an error instead of making changes
- User must reduce the pattern scope or confirm the large operation

### Line Number Validation

- Line numbers must be positive integers
- Line numbers cannot exceed total lines in file
- `start` must be ≤ `end`
- Invalid line numbers trigger an error with details

## Error Handling

**Path not found:**

```json
{ "error": "path does not exist or is not a file" }
```

**Line range beyond file length:**

```json
{ "error": "line range is beyond file length" }
```

**Invalid range:**

```json
{ "error": "start must be <= end" }
```

**Overlapping edits:**

```json
{ "error": "edits contain overlapping line ranges" }
```

**Mutual exclusivity:**

```json
{ "error": "edits is mutually exclusive with start/end" }
```

## Tips

- Use `dryRun: true` to preview changes before applying them
- For large replacements, consider breaking into smaller operations
- Positional edits are more efficient than regex for structural changes
- The tool automatically handles line ending preservation
- Use `maxOccurrences` to limit the scope of regex replacements
- Range operations are inclusive (both start and end lines are affected)
- Empty replacement strings are valid for range replacement (deletes the range)
- Use `fixedStrings: true` when matching literal text that contains regex metacharacters
- Use `edits` when making multiple changes to a single file to avoid line-shifting errors — all edits reference the original file state

## Automatic Escape Sanitization

The tool loop automatically sanitizes invalid JSON escape sequences in tool call arguments before they reach the tool. When an LLM produces a regex pattern like `\d{3}` or `\(foo\)`, the raw JSON contains invalid escapes (`\d`, `\{`, `\(`) that would normally break JSON parsing. The sanitizer detects these and doubles the backslash (`\\d`, `\\{`, `\\(`), preserving the intended regex pattern.

This means:

- LLMs do **not** need to double-escape regex metacharacters in practice — the sanitizer handles it
- Already-valid escapes (`\n`, `\t`, `\\`, `\"`, `\uXXXX`) are left untouched
- The fix is applied transparently before the tool executes
- If the args are still unparseable after sanitization, the tool call is skipped and an error is returned
