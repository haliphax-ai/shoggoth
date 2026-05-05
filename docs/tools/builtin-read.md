# builtin-read

Read file content (text or image) from the workspace. Supports line ranges, multi-file globs, and stat-only mode. This tool is permitted special access to read from the Shoggoth app directory for inspecting system source code and documentation.

## Parameters

| Param         | Type     | Required              | Notes                                                                          |
| ------------- | -------- | --------------------- | ------------------------------------------------------------------------------ |
| `path`        | string   | one of `path`/`paths` | Single file path (workspace-relative)                                          |
| `paths`       | string[] | one of `path`/`paths` | Multiple paths or glob patterns                                                |
| `maxFiles`    | number   | no                    | Cap on files returned for `paths` (default: 20)                                |
| `fromLine`    | number   | no                    | First line to include, 1-indexed. Mutually exclusive with `offset`             |
| `toLine`      | number   | no                    | Last line to include, 1-indexed inclusive. Mutually exclusive with `limit`     |
| `offset`      | number   | no                    | Starting line, 1-indexed. Mutually exclusive with `fromLine`                   |
| `limit`       | number   | no                    | Max lines to read. Mutually exclusive with `toLine`                            |
| `stat`        | boolean  | no                    | Return metadata only (size, mtime, type, permissions, line count) — no content |
| `lines`       | boolean  | no                    | Split content by newlines and return as array                                  |
| `lineNumbers` | boolean  | no                    | Prefix each line with its line number (1-indexed)                              |

`path` and `paths` are mutually exclusive. `fromLine`/`toLine` and `offset`/`limit` are mutually exclusive.

## Output Format

### Default Mode

Returns content as a string:

```json
{
  "path": "src/foo.ts",
  "content": "file content here..."
}
```

### Lines Mode (`lines: true`)

Returns content as an array of strings, one per line:

```json
{
  "path": "src/foo.ts",
  "content": ["line 1", "line 2", "line 3"]
}
```

### Line Numbers Mode (`lineNumbers: true`)

Returns content with line number prefixes:

```json
{
  "path": "src/foo.ts",
  "content": "1: line 1\n2: line 2\n3: line 3"
}
```

### Combined Mode (`lines: true, lineNumbers: true`)

Returns array with line number prefixes:

```json
{
  "path": "src/foo.ts",
  "content": ["1: line 1", "2: line 2", "3: line 3"]
}
```

## Examples

**Read a file:**

```json
{ "path": "src/foo.ts" }
```

**Read lines 10–25:**

```json
{ "path": "src/foo.ts", "fromLine": 10, "toLine": 25 }
```

**Read 50 lines starting at line 100:**

```json
{ "path": "src/foo.ts", "offset": 100, "limit": 50 }
```

**Read multiple files:**

```json
{ "paths": ["src/foo.ts", "src/bar.ts"] }
```

**Glob pattern:**

```json
{ "paths": ["src/**/*.test.ts"], "maxFiles": 10 }
```

**Stat a file (no content):**

```json
{ "path": "src/foo.ts", "stat": true }
```

**Stat multiple files:**

```json
{ "paths": ["src/*.ts"], "stat": true }
```

**Read file as lines array:**

```json
{ "path": "src/foo.ts", "lines": true }
```

**Read file with line numbers:**

```json
{ "path": "src/foo.ts", "lineNumbers": true }
```

**Read file as lines with line numbers:**

```json
{ "path": "src/foo.ts", "lines": true, "lineNumbers": true }
```

## Large File Handling

When reading files with `lines: true` that contain more than 1000 lines:

- Only the first 1000 lines are returned
- A truncation notice is appended to the content array
- Example: `["line 1", "line 2", ..., "... truncated — file has 1500 lines, showing first 1000 ..."]`

## Tips

- Image files (jpg, png, gif, webp) are returned as image content parts — no special params needed.
- Multi-file reads are capped at 2000 lines / 50 KB per file; excess is truncated.
- Binary files are detected and skipped in multi-file mode.
- Use `stat` to check file size and line count before reading large files.
- Line ending formats (LF, CRLF, CR) are all handled correctly when splitting lines.
- Empty files return empty arrays when using `lines: true`.
- Files consisting only of newlines preserve all line breaks correctly.
