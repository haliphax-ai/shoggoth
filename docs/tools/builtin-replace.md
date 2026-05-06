# builtin-replace

Replace patterns in files with support for regex replacements, line-level operations, and dry-run mode. Provides safety warnings for large numbers of replacements and preserves line endings.

## Parameters

| Param            | Type         | Required | Notes                                                             |
| ---------------- | ------------ | -------- | ----------------------------------------------------------------- |
| `path`           | string       | yes      | Workspace-relative path to the file to modify                     |
| `pattern`        | string       | no       | Regex pattern to match (required for regex replacement)           |
| `replacement`    | string       | no       | Replacement text (supports `$1`–`$9` capture groups)              |
| `caseSensitive`  | boolean      | no       | Set `false` for case-insensitive (default: true)                  |
| `maxOccurrences` | number       | no       | Maximum number of replacements to make (default: unlimited)       |
| `dryRun`         | boolean      | no       | Preview changes without modifying file (default: false)           |
| `deleteLines`    | number[]     | no       | Array of line numbers to delete                                   |
| `deleteLine`     | number       | no       | Single line number to delete (singular form, backward compatible) |
| `deleteRange`    | {start, end} | no       | Delete lines from start to end (inclusive)                        |
| `replaceRange`   | {start, end} | no       | Replace lines from start to end (inclusive)                       |

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

### 2. Line Deletion

Delete specific lines or ranges:

```json
{
  "path": "src/foo.ts",
  "deleteLines": [10, 20, 30]
}
```

### 3. Range Deletion

Delete a contiguous range of lines:

```json
{
  "path": "src/foo.ts",
  "deleteRange": { "start": 10, "end": 20 }
}
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
  "replacement": "newName",
  "fixedStrings": true
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
  "deleteLine": 42
}
```

**Delete line range:**

```json
{
  "path": "src/foo.ts",
  "deleteRange": { "start": 10, "end": 20 }
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
  "deleteRange": { "start": 10, "end": 15 },
  "dryRun": true
}
```

### Multiline Examples

**Multiline literal replace:**

```json
{
  "path": "src/foo.ts",
  "pattern": "if (old) {\\n  return false;\\n}",
  "replacement": "if (updated) {\\n  return true;\\n}",
  "fixedStrings": true,
  "multiline": true
}
```

**Multiline regex replace:**

```json
{
  "path": "src/foo.ts",
  "pattern": "// BEGIN BLOCK\\n[\\\\s\\\\S]*?// END BLOCK",
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

## Automatic Escape Sanitization

The tool loop automatically sanitizes invalid JSON escape sequences in tool call arguments before they reach the tool. When an LLM produces a regex pattern like `\d{3}` or `\(foo\)`, the raw JSON contains invalid escapes (`\d`, `\{`, `\(`) that would normally break JSON parsing. The sanitizer detects these and doubles the backslash (`\\d`, `\\{`, `\\(`), preserving the intended regex pattern.

This means:

- LLMs do **not** need to double-escape regex metacharacters in practice — the sanitizer handles it
- Already-valid escapes (`\n`, `\t`, `\\`, `\"`, `\uXXXX`) are left untouched
- The fix is applied transparently before the tool executes
- If the args are still unparseable after sanitization, the tool call is skipped and an error is returned
