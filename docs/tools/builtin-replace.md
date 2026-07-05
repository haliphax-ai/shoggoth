# builtin-replace

Replace patterns in files with support for regex replacements, line-level operations, and dry-run mode. Provides safety warnings for large numbers of replacements and preserves line endings.

## Parameters

| Param            | Type                               | Required | Notes                                                                                 |
| ---------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `path`           | string                             | yes      | Workspace-relative path to the file to modify                                         |
| `pattern`        | string                             | no       | Regex pattern to match (required for regex replacement)                               |
| `replacement`    | string                             | no       | Replacement text (supports `$1`–`$9` capture groups)                                  |
| `caseSensitive`  | boolean                            | no       | Set `false` for case-insensitive (default: true)                                      |
| `maxOccurrences` | number                             | no       | Maximum number of replacements to make (default: unlimited)                           |
| `dryRun`         | boolean                            | no       | Preview changes without modifying file (default: false)                               |
| `fixedStrings`   | boolean                            | no       | Treat pattern as a literal string, not regex (default: false)                         |
| `multiline`      | boolean                            | no       | Enable multiline mode (`m` flag) for regex patterns (default: false)                  |
| `deleteLines`    | number \| number[] \| {start, end} | no       | Line(s) to delete: single 1-indexed number, array of numbers, or `{start, end}` range |
| `replaceRange`   | {start, end}                       | no       | Replace lines from start to end (inclusive, 1-indexed)                                |

## Operation Modes

### 1. Regex Replacement

Replace text matching a regex pattern:

```json
{
  "path": "src/foo.ts",
  "pattern": "oldName",
  "replacement": "newName"
}
```

### 2. Literal (fixedStrings) Replacement

Replace text matching a literal string — no regex escaping needed:

```json
{
  "path": "src/foo.ts",
  "pattern": "fn(arg1, arg2)",
  "replacement": "fn(arg1, arg2, arg3)",
  "fixedStrings": true
}
```

### 3. Line Deletion

Delete a single line, multiple lines, or a range using the unified `deleteLines` parameter:

```json
// Single line
{ "path": "src/foo.ts", "deleteLines": 42 }

// Multiple lines
{ "path": "src/foo.ts", "deleteLines": [10, 20, 30] }

// Range
{ "path": "src/foo.ts", "deleteLines": { "start": 10, "end": 20 } }
```

### 4. Range Replacement

Replace a contiguous range of lines:

```json
{
  "path": "src/foo.ts",
  "replaceRange": { "start": 10, "end": 15 },
  "replacement": "new content"
}
```

## Dry Run Mode

When `dryRun: true` is specified, the tool returns a preview of changes without modifying the file:

**Regex replacement preview:**

```json
{
  "modified": false,
  "changesMade": 3,
  "preview": "Dry-run mode: No files will be modified.\n  Line 5: Change\n    Before: const oldName = \"test\";\n    After:  const newName = \"test\";\n...\n3 replacements would be made."
}
```

**Line deletion preview:**

```json
{
  "modified": false,
  "changesMade": 2,
  "deletedLines": 2,
  "preview": "Dry-run mode: No files will be modified.\n  Line 10: Delete\n    Content: // deprecated code\n  Line 20: Delete\n    Content: // another deprecated line\n\n2 lines would be deleted."
}
```

## Return Value Structure

**Successful replacement:**

```json
{
  "modified": true,
  "changesMade": 5
}
```

**With line operations:**

```json
{
  "modified": true,
  "changesMade": 3,
  "deletedLines": 3 // or "replacedLines": 3 for range replacement
}
```

**Dry run with preview:**

```json
{
  "modified": false,
  "changesMade": 2,
  "preview": "Dry-run mode: No files will be modified.\n..."
}
```

**Safety warning (too many matches):**

```json
{
  "warning": "Large number of replacements (1500) detected. Use with caution.",
  "modified": false,
  "changesMade": 1500
}
```

## Examples

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

### Line Operation Examples

**Delete specific lines:**

```json
{
  "path": "src/foo.ts",
  "deleteLines": [10, 25, 30]
}
```

**Delete single line:**

```json
{
  "path": "src/foo.ts",
  "deleteLines": 42
}
```

**Delete line range:**

```json
{
  "path": "src/foo.ts",
  "deleteLines": { "start": 10, "end": 20 }
}
```

**Replace line range with single string:**

```json
{
  "path": "src/foo.ts",
  "replaceRange": { "start": 10, "end": 15 },
  "replacement": "// Updated section"
}
```

**Replace line range with multiple lines:**

```json
{
  "path": "src/foo.ts",
  "replaceRange": { "start": 10, "end": 12 },
  "replacement": "line 1\nline 2\nline 3"
}
```

**Preview line deletion:**

```json
{
  "path": "src/foo.ts",
  "deleteLines": { "start": 10, "end": 15 },
  "dryRun": true
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

- The tool returns a warning instead of making changes
- User must reduce the pattern scope or confirm the large operation
- Example warning: `"Large number of replacements (1500) detected. Use with caution."`

### Line Number Validation

- Line numbers must be positive integers
- Line numbers cannot exceed total lines in file
- Invalid line numbers trigger an error with details

## Line Ending Preservation

The tool preserves original line endings:

- Files with LF (`\n`) keep LF endings
- Files with CRLF (`\r\n`) keep CRLF endings
- Files with CR (`\r`) keep CR endings
- Trailing newlines are preserved
- Empty files remain empty after operations

## Error Handling

**Path not found:**

```json
{
  "error": "Path not found: src/nonexistent.ts"
}
```

**Invalid line numbers:**

```json
{
  "error": "Invalid line numbers: 100, 200. Total lines: 50"
}
```

**Out of range:**

```json
{
  "error": "Out of range: start=10, end=20, totalLines=15"
}
```

**Invalid range:**

```json
{
  "error": "Invalid range: start=20 is greater than end=10"
}
```

## Tips

- Use `dryRun: true` to preview changes before applying them
- For large replacements, consider breaking into smaller operations
- Line operations are more efficient than regex for structural changes
- The tool automatically handles line ending preservation
- Use `maxOccurrences` to limit the scope of regex replacements
- Range operations are inclusive (both start and end lines are affected)
- Empty replacement strings are valid for range replacement
- Use `fixedStrings: true` when matching literal text that contains regex metacharacters

## Automatic Escape Sanitization

The tool loop automatically sanitizes invalid JSON escape sequences in tool call arguments before they reach the tool. When an LLM produces a regex pattern like `\d{3}` or `\(foo\)`, the raw JSON contains invalid escapes (`\d`, `\{`, `\(`) that would normally break JSON parsing. The sanitizer detects these and doubles the backslash (`\\d`, `\\{`, `\\(`), preserving the intended regex pattern.

This means:

- LLMs do **not** need to double-escape regex metacharacters in practice — the sanitizer handles it
- Already-valid escapes (`\n`, `\t`, `\\`, `\"`, `\uXXXX`) are left untouched
- The fix is applied transparently before the tool executes
- If the args are still unparseable after sanitization, the tool call is skipped and an error is returned
