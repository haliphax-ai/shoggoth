# Replace Tool Multiline Support Specification

## Tool Schema Changes

### Current Schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "pattern": { "type": "string" },
    "replacement": { "type": "string" },
    "caseSensitive": { "type": "boolean" },
    "maxOccurrences": { "type": "integer" },
    "dryRun": { "type": "boolean" },
    "deleteLines": { "type": "array", "items": { "type": "integer" } },
    "deleteLine": { "type": "integer" },
    "deleteRange": {
      "type": "object",
      "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }
    },
    "replaceRange": {
      "type": "object",
      "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }
    }
  },
  "required": ["path"]
}
```

### New Schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "pattern": { "type": "string" },
    "replacement": { "type": "string" },
    "caseSensitive": { "type": "boolean" },
    "maxOccurrences": { "type": "integer" },
    "dryRun": { "type": "boolean" },
    "multiline": {
      "type": "boolean",
      "description": "When true, regex patterns are treated as multiline (m flag)"
    },
    "deleteLines": { "type": "array", "items": { "type": "integer" } },
    "deleteLine": { "type": "integer" },
    "deleteRange": {
      "type": "object",
      "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }
    },
    "replaceRange": {
      "type": "object",
      "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } }
    }
  },
  "required": ["path"]
}
```

## Regex Flag Logic

### Current

```typescript
const regexFlags = caseSensitive ? "g" : "gi";
```

### New

```typescript
const regexFlags = caseSensitive ? (multiline ? "gm" : "g") : multiline ? "gmi" : "gi";
```

## Pattern Requirement Logic

### Current

- `pattern` is always required for any replacement operation
- Line-range operations (deleteLine, deleteRange, replaceRange) still require `pattern`

### New

- `pattern` is only required when performing pattern-based replacement
- Line-range operations do not require `pattern`
- Validation logic: `pattern` required unless `deleteLine`, `deleteLines`, `deleteRange`, or `replaceRange` is specified

## Examples

### Multiline Pattern Replacement

```typescript
// Replace text across multiple lines
await replace({
  path: "file.txt",
  pattern: "line1\\nline2",
  replacement: "replaced",
  multiline: true,
});
```

### Line Range Operations (no pattern required)

```typescript
// Delete specific lines (no pattern needed)
await replace({
  path: "file.txt",
  deleteLine: 5,
});

// Replace range of lines (no pattern needed)
await replace({
  path: "file.txt",
  replaceRange: { start: 1, end: 3 },
  replacement: "new content",
});
```

## Edge Cases

1. **Empty pattern with line operations**: Should work (pattern ignored)
2. **Pattern with multiline flag but no newlines**: Should work normally
3. **Multiline with line operations**: Line operations take precedence, multiline flag ignored
4. **Case-insensitive multiline**: Should use "gmi" flags
