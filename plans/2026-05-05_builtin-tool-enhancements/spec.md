# Builtin Tool Enhancements Specification

## Overview

This document provides detailed specifications for each enhancement to builtin tools, including interface signatures, behaviors, and example usage.

---

## Phase 1: Formatted Output for `builtin-read`

### Current Behavior

```typescript
// Current implementation returns single line
builtin-read(path: string): string
// Output: "line1\nline2\nline3"
```

### New Interface

```typescript
interface BuiltinReadParams {
  path: string; // File path to read
  lines?: boolean; // Split output by newline characters
  lineNumbers?: boolean; // Prefix each line with number
}
```

### Expected Output Formats

**Basic (current):**

```
line1
line2
line3
```

**With `lines: true` (split):**

```
line1
line2
line3
```

(Split by newline, joined back with newlines)

**With `lineNumbers: true`:**

```
1: line1
2: line2
3: line3
```

**With both flags:**

```
1: line1
2: line2
3: line3
```

### Large File Handling

- Files > 1000 lines: Add truncation warning
- Provide option to show only first/last N lines

### Edge Cases

1. Empty files: Return empty string regardless of flags
2. Files with special characters: Escape properly
3. Binary files: Detect and warn user

---

## Phase 2: Split `builtin-search-replace`

### New `builtin-search` Tool

```typescript
interface BuiltinSearchParams {
  path: string; // File or directory path
  pattern: string; // Regex pattern to search
  caseSensitive?: boolean; // Default: false
  contextLines?: number; // Lines of context around matches (default: 2)
  maxResults?: number; // Cap results (default: 100)
}
```

**Return Value:**

```typescript
interface SearchResults {
  matches: Array<{
    filePath: string;
    lineNumber: number;
    context: string;
    matchedText: string;
  }>;
  totalMatches: number;
}
```

### Modified `builtin-search-replace` Tool

```typescript
interface BuiltinReplaceParams {
  path: string; // File path (breaking change: rename from `file`)
  pattern: string; // Regex pattern to match
  replacement: string; // Replacement text
  caseSensitive?: boolean; // Default: false
  maxOccurrences?: number; // Limit replacements (default: Infinity)
  dryRun?: boolean; // NEW: Preview without modifying
  deleteLines?: number[]; // NEW: Array of line numbers to delete (1-indexed)
  deleteRange?: {
    // NEW: Alternative: range deletion
    start: number;
    end: number;
  };
  replaceRange?: {
    // NEW: Replace a range of lines
    start: number;
    end: number;
    replacement: string | string[];
  };
}
```

### Breaking Change: Parameter Renaming

- **Remove** `file` parameter support entirely
- **Use** `path` parameter consistently across both tools
- Update all examples and documentation to use `path` only

---

## Phase 3: Improved Regex Error Messages

### Current Error Format

```
Error: Invalid regular expression...
```

### New Error Format

```
Error: Invalid regular expression at position 15:
  Pattern: /abc[d/
              ^
  Context: The pattern is missing a closing bracket ']'
```

### Error Components

1. **Position indicator**: Character position where parsing failed
2. **Pattern display**: Show the problematic pattern with marker
3. **Context explanation**: User-friendly description of the issue
4. **Suggestion**: Optional recommended fix

### Error Handling

```typescript
try {
  new RegExp(userPattern, flags);
} catch (e: any) {
  if (e instanceof SyntaxError) {
    throw new ToolError(
      `Invalid regex pattern at position ${e.index}:
  Pattern: /${userPattern}/
  Error: ${e.message}`,
    );
  }
  throw e;
}
```

---

## Phase 4: Multiline String Support in `builtin-exec`

### Current Limitation

```bash
# Difficult to pass multiline content
builtin-exec argv: ["git", "commit", "-m", "line1\nline2\nline3"]
```

### New Approaches

**Option A: JSON Array with String Arrays (Recommended)**

Support proper JSON escaping in strings passed through tool APIs:

```typescript
// When argv contains:
builtin-exec(argv: ["bash", "-c", "echo 'line1\\nline2'"])

// The string "line1\nline2" preserves newlines
// Bash interprets \n appropriately based on command
```

**Implementation Guideline:**

- Accept standard JSON escaping in strings
- Properly escape arguments for shell execution
- Document escaping expectations clearly

### Documentation Requirements

- Examples with commit messages
- Examples with script content
- Shell escaping guidelines

---

## Phase 5: Dry-Run Mode for Replacements

### New Interface Extension

```typescript
interface BuiltinReplaceParams {
  path: string;
  pattern: string;
  replacement: string;
  caseSensitive?: boolean;
  maxOccurrences?: number;
  dryRun?: boolean; // NEW: Preview changes only
}
```

### Dry-Run Output Format

```
Dry-run mode: No files will be modified.

File: example.ts
  Line 42: Change
    Before: const x = 10;
    After:  const x = 20;

  Line 157: Change
    Before: let y = false;
    After:  let y = true;

2 replacements would be made.
```

### Implementation Details

1. Parse file into lines
2. Apply regex to find all matches
3. For each match, compute replacement
4. Output diff-like format showing changes
5. If `dryRun: false`, apply changes

### Safety Features

- Always require explicit `dryRun: false` to modify files
- For non-dry-run, show final confirmation prompt if > 10 changes
- Never modify files if pattern matches > 1000 locations (prevent accidents)

---

## Phase 6: Line-Level Operations

### Line Deletion

**Interface:**

```typescript
interface BuiltinReplaceParams {
  path: string;
  deleteLines?: number[]; // Array of line numbers to delete (1-indexed)
  deleteRange?: {
    // Alternative: range deletion
    start: number;
    end: number;
  };
}
```

**Example Usage:**

```
Delete lines 10-20:
{
  path: "file.ts",
  deleteRange: { start: 10, end: 20 }
}

Delete lines 5, 15, 25:
{
  path: "file.ts",
  deleteLines: [5, 15, 25]
}
```

### Range Replacement

**Interface:**

```typescript
interface BuiltinReplaceParams {
  path: string;
  replaceRange?: {
    // Replace a range of lines
    start: number;
    end: number;
    replacement: string | string[]; // Single string or array of strings
  };
}
```

**Example Usage:**

```
Replace lines 5-10 with new content:
{
  path: "config.yaml",
  replaceRange: {
    start: 5,
    end: 10,
    replacement: [
      "new_key: value1",
      "new_key: value2"
    ]
  }
}
```

### Implementation Details

1. **Line numbering**: 1-indexed for user-friendliness
2. **Error handling**:
   - Out-of-range lines: Clear error message
   - Overlapping deletions: Merge and warn
   - Invalid ranges: End < start
3. **File format preservation**:
   - Maintain original line endings (CRLF vs LF)
   - Preserve trailing newline if present

### Edge Cases

- Deleting entire file
- Replacing with empty content
- Ranges that span entire file
- Mixed line ending types

---

## Phase 7: Documentation Specifications

### Documentation Structure

Each tool documentation should follow this structure:

1. **Overview**: Brief description of the tool's purpose
2. **Parameters**: Table with name, type, required, default, description
3. **Examples**: Copy-paste ready usage examples
4. **Error Handling**: Common errors and how to resolve them
5. **Edge Cases**: Special scenarios and how they're handled
6. **Performance Notes**: Any relevant performance considerations

### Per-Tool Documentation Requirements

#### `builtin-read.md`

- Document `lines` and `lineNumbers` parameters
- Show output examples for all flag combinations
- Explain large file handling and truncation limits

#### `builtin-search.md` (new)

- Complete new tool documentation
- Document structured return value (matches array)
- Provide search pattern examples (simple, regex, escaped)
- Explain `contextLines` and `maxResults` usage

#### `builtin-replace.md` (new)

- Document standalone replace functionality
- Explain dry-run mode thoroughly
- Document line-level operations (`deleteLines`, `replaceRange`)
- Clearly document breaking change: `file` → `path` parameter removal

#### `builtin-search-replace.md` (update)

- Update documentation reflecting new parameter naming
- Document breaking change: `file` parameter removed
- Clarify relationship between tools

#### `builtin-exec.md`

- Document multiline string handling patterns
- Provide examples with commit messages and scripts
- Explain shell escaping guidelines

### Testing Documentation

- Verify all code examples in docs work correctly
- Ensure API reference matches implementation
- Validate error message documentation
- Clearly document all breaking changes

---

## API Versioning

- All changes are additive or non-breaking (except parameter rename)
- Breaking change: `file` → `path` parameter rename
- Release notes will document all changes clearly

---

## Testing Strategy

### Unit Tests

- Each tool gets dedicated test file
- Test all parameter combinations
- Mock file system operations
- Test error handling specifically

### Integration Tests

- Real file operations with cleanup
- Cross-tool scenarios
- Large file handling
- Edge case testing

### Regression Tests

- Existing usage patterns will break for `file` parameter
- Verify `path` parameter works correctly
- Test that invalid parameter names are rejected

---

## Documentation Updates Required

1. Tool reference documentation for each modified/new tool
2. Examples for each new feature
3. Error message reference
4. API documentation updates
5. Migration guide for breaking change

---

## Examples

### Example 1: Read with Line Numbers

```typescript
builtin-read(
  path: "src/utils.ts",
  lines: true,
  lineNumbers: true
)
// Output:
// 1: import React from 'react'
// 2:
// 3: export const Utils = { ... }
```

### Example 2: Search with Context

```typescript
builtin-search(
  path: "src/",
  pattern: "TODO:.*",
  contextLines: 3
)
// Output:
// {
//   matches: [{
//     filePath: "src/utils.ts",
//     lineNumber: 15,
//     context: "export function format(data) {",
//     matchedText: "TODO: Improve error handling"
//   }],
//   totalMatches: 1
// }
```

### Example 3: Replace with Dry Run

```typescript
builtin-search-replace(
  path: "config.json", // BREAKING: 'file' no longer supported
  pattern: "\"debug\": true",
  replacement: "\"debug\": false",
  dryRun: true
)
// Output:
// Dry-run mode: No files will be modified.
// File: config.json
//   Line 5: Change
//     Before: "debug": true
//     After:  "debug": false
//
// 1 replacement would be made.
```

### Example 4: Range Replacement

```typescript
builtin-search-replace(
  path: "Dockerfile",
  replaceRange: {
    start: 1,
    end: 3,
    replacement: "FROM node:18-alpine"
  }
)
// Output:
// { replacedLines: 3, modified: true }
```

### Example 5: Breaking Change Example

```typescript
// BEFORE (no longer works):
builtin-search-replace(
  file: "config.json", // ❌ This will fail
  pattern: "old",
  replacement: "new"
)

// AFTER (correct usage):
builtin-search-replace(
  path: "config.json", // ✅ Use 'path' instead
  pattern: "old",
  replacement: "new"
)
```

---

## Success Criteria

- All specifications are clear and actionable
- Examples demonstrate real-world usage
- Error handling is comprehensive
- Documentation is complete and accurate
- Breaking changes clearly documented
- API reference is consistent with implementation
