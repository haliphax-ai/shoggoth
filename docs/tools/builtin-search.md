# builtin-search

Search for patterns in files within the workspace. Supports regex patterns, case-insensitive search, context lines, and file/directory path filtering.

## Parameters

| Param           | Type    | Required | Notes                                                 |
| --------------- | ------- | -------- | ----------------------------------------------------- |
| `path`          | string  | yes      | File or directory path to search (workspace-relative) |
| `pattern`       | string  | yes      | Regex pattern to search for                           |
| `caseSensitive` | boolean | no       | Set `false` for case-insensitive (default: true)      |
| `contextLines`  | number  | no       | Lines of context around each match (default: 2)       |
| `maxResults`    | number  | no       | Maximum number of matches to return (default: 100)    |

## Return Value Structure

The tool returns a JSON object with the following structure:

```json
{
  "matches": [
    {
      "filePath": "src/example.ts",
      "lineNumber": 42,
      "context": "line 40\nline 41\nline 42  // match here\nline 43\nline 44",
      "matchedText": "match here"
    }
  ],
  "totalMatches": 15
}
```

### Match Object Fields

- `filePath`: Relative path to the file containing the match
- `lineNumber`: 1-indexed line number where the match occurs
- `context`: String containing the matched line and surrounding context lines (separated by newlines)
- `matchedText`: The actual text that matched the pattern

## Examples

**Basic search:**

```json
{
  "path": "src",
  "pattern": "TODO"
}
```

**Case-insensitive search:**

```json
{
  "path": "src/app.ts",
  "pattern": "error",
  "caseSensitive": false
}
```

**Search with context lines:**

```json
{
  "path": "src",
  "pattern": "function",
  "contextLines": 3
}
```

**Limit results:**

```json
{
  "path": "src",
  "pattern": "import",
  "maxResults": 10
}
```

**Search specific file:**

```json
{
  "path": "src/main.ts",
  "pattern": "console\\.log"
}
```

## Search Behavior

### Directory Search

When searching a directory:

- Only files in the specified directory are searched (non-recursive)
- Context lines are set to 0 for directory searches to save memory
- Binary files are automatically skipped

### File Search

When searching a specific file:

- Context lines are included around each match (default: 2 lines)
- Multiple matches per line are supported
- Line endings (LF, CRLF, CR) are handled correctly

### Pattern Matching

- Patterns are treated as regular expressions by default
- Use proper regex escaping for literal characters
- Case-insensitive mode uses the `gi` flags
- Empty patterns return no matches

## Error Handling

The tool returns error information in the following cases:

**Pattern not provided:**

```json
{
  "matches": [],
  "totalMatches": 0
}
```

**Path not found:**

```json
{
  "error": "Path not found: src/nonexistent.ts",
  "matches": [],
  "totalMatches": 0
}
```

**Invalid regex pattern:**

```json
{
  "error": "Invalid regex pattern: ...",
  "matches": [],
  "totalMatches": 0
}
```

## Tips

- Use `caseSensitive: false` for case-insensitive searches
- Adjust `contextLines` to see more or less surrounding code
- Set `maxResults` to limit output for large codebases
- Search results are returned as structured data, not formatted text
- The `context` field includes the matched line plus surrounding lines for better understanding
- Directory searches are non-recursive (only search specified directory, not subdirectories)
