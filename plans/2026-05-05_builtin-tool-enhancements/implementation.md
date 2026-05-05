# Builtin Tool Enhancements - Implementation Guide

## Overview

This document outlines the implementation phases for the builtin tool enhancements. Each phase is designed to be independently developable, testable, and shippable.

---

## Phase 1: Formatted Output for `builtin-read`

### Files to Modify

- `packages/shoggoth/src/tools/builtin-read.ts`

### Implementation Steps

1. **Add parameters to schema:**

   ```typescript
   {
     type: "object",
     properties: {
       path: { type: "string" },
       lines: {
         type: "boolean",
         description: "Split output by newline characters",
         default: false
       },
       lineNumbers: {
         type: "boolean",
         description: "Prefix each line with number",
         default: false
       }
     }
   }
   ```

2. **Implement line-splitting logic:**

   ```typescript
   const content = await fs.readFile(path, "utf-8");

   if (params.lines) {
     const lines = content.split("\n");
     const outputLines = params.lineNumbers ? lines.map((line, i) => `${i + 1}: ${line}`) : lines;
     return outputLines.join("\n");
   }

   return content;
   ```

3. **Handle large files:**
   ```typescript
   const MAX_LINES = 1000;
   if (!params.lines && content.split("\n").length > MAX_LINES) {
     return `${content.substring(0, 2000)}\n\n[Truncated: ${content.split("\n").length - 1000} additional lines]`;
   }
   ```

### Testing Requirements

- [ ] Test empty file
- [ ] Test single-line file
- [ ] Test file with special characters (tabs, null bytes)
- [ ] Test file with CRLF line endings
- [ ] Test large file (> 1000 lines)
- [ ] Test combination of flags
- [ ] Verify default behavior unchanged

### Expected Behavior

| Flags               | Output                               |
| ------------------- | ------------------------------------ |
| None                | Raw file content (existing behavior) |
| `lines: true`       | Split by newline, joined back        |
| `lineNumbers: true` | Each line prefixed with `N: `        |
| Both                | Combined effect                      |

---

## Phase 2: Split `builtin-search-replace`

### Files to Create/Modify

- `packages/shoggoth/src/tools/builtin-search.ts` (new)
- `packages/shoggoth/src/tools/builtin-search-replace.ts` (modify)
- `packages/shoggoth/src/tools/index.ts` (update registration)
- `docs/tools/builtin-search.md` (new)
- `docs/tools/builtin-search-replace.md` (update deprecation notice)

### Implementation Steps

#### Step 2a: Create `builtin-search`

```typescript
// packages/shoggoth/src/tools/builtin-search.ts
export const builtinSearch: ToolDefinition = {
  name: "builtin-search",
  description: "Search for patterns in files",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      pattern: { type: "string" },
      caseSensitive: { type: "boolean", default: false },
      contextLines: { type: "number", default: 2 },
      maxResults: { type: "number", default: 100 },
    },
    required: ["path", "pattern"],
  },
  execute: async (params) => {
    // Implementation using existing ripgrep or similar
    // Return structured results with filePath, lineNumber, context, matchedText
  },
};
```

#### Step 2b: Modify `builtin-search-replace`

```typescript
// packages/shoggoth/src/tools/builtin-search-replace.ts
// Change parameter name from `file` to `path`
inputSchema: {
  properties: {
    path: { type: "string" }, // Was `file`
    pattern: { type: "string" },
    replacement: { type: "string" },
    // ... other params
  },
  deprecatedParams: {
    file: "Use 'path' instead"
  }
}
```

#### Step 2c: Update Tool Registration

```typescript
// packages/shoggoth/src/tools/index.ts
import { builtinSearch } from "./builtin-search";
import { builtinSearchReplace } from "./builtin-search-replace";

export const builtinTools = [
  // ... other tools
  builtinSearch,
  builtinSearchReplace,
];
```

### Testing Requirements

- [ ] Test search returns correct matches
- [ ] Test search respects case sensitivity
- [ ] Test search respects context lines
- [ ] Test search respects max results
- [ ] Test replace maintains old behavior
- [ ] Test parameter name migration (`file` → `path`)
- [ ] Test deprecation warning when using `file`

---

## Phase 3: Improved Regex Error Messages

### Files to Modify

- `packages/shoggoth/src/tools/builtin-search.ts`
- `packages/shoggoth/src/tools/builtin-search-replace.ts`

### Implementation Steps

1. **Wrap regex compilation in try-catch:**
   ```typescript
   try {
     const flags = params.caseSensitive ? "" : "i";
     const regex = new RegExp(params.pattern, flags);
   } catch (e: any) {
     if (e instanceof SyntaxError) {
       const error = new ToolError(
         `Invalid regular expression at position ${e.index}:
   Pattern: /${params.pattern}/
   Error: ${e.message}
   ```

Tip: Check for unescaped special characters like \*, +, ?, |, [, or unclosed groups/brackets.`
);
throw error;
}
throw e;
}

````

2. **Create error utility function:**
```typescript
// packages/shoggoth/src/lib/error-utils.ts
export function formatRegexError(pattern: string, regexError: SyntaxError): string {
  const position = regexError.index ?? 0;
  const context = pattern.substring(Math.max(0, position - 10), position + 10);

  return `Invalid regular expression:
Pattern: /${pattern}/
Failed at position ${position}:
 ${context}
 ${" ".repeat(position - Math.max(0, position - 10))}^
Detail: ${regexError.message}`;
}
````

### Testing Requirements

- [ ] Test with unclosed brackets `[abc`
- [ ] Test with unclosed groups `(abc`
- [ ] Test with invalid escape sequences `\[invalid]`
- [ ] Test with missing closing delimiter `/abc/` vs `/abc`
- [ ] Test with malformed quantifiers `a**b`
- [ ] Verify error messages are readable and actionable

---

## Phase 4: Multiline String Support in `builtin-exec`

### Files to Modify

- `packages/shoggoth/src/tools/builtin-exec.ts`

### Implementation Options

#### Option A: JSON-aware String Parsing (Recommended)

Update the tool to accept proper JSON escaping in strings passed via argv.

**Implementation:**

```typescript
execute: async (params) => {
  const { argv } = params;

  // Ensure each arg is properly escaped for shell
  const escapedArgs = argv.map((arg) => shellEscape(arg));

  const command = escapedArgs.join(" ");
  // Execute command...
};
```

#### Option B: Multi-line Block Syntax

Add a separate parameter for multi-line content:

```typescript
interface BuiltinExecParams {
  argv: string[];
  multiline?: string; // Additional multi-line content
}
```

### Testing Requirements

- [ ] Test with simple multiline strings (newlines preserved)
- [ ] Test with complex escaping (quotes, backslashes)
- [ ] Test with commit message examples
- [ ] Test with script content
- [ ] Verify proper shell escaping

---

## Phase 5: Dry-Run Mode for Replacements

### Files to Modify

- `packages/shoggoth/src/tools/builtin-search-replace.ts`

### Implementation Steps

1. **Add dry-run parameter:**

   ```typescript
   {
     dryRun: {
       type: "boolean",
       default: false,
       description: "Preview changes without modifying files"
     }
   }
   ```

2. **Implement preview logic:**

   ```typescript
   execute: async (params) => {
     const content = await fs.readFile(params.path, "utf-8");
     const lines = content.split("\n");
     const regex = new RegExp(pattern);

     const changes: Array<{ lineNumber: number; before: string; after: string }> = [];
     let modified = content;

     for (let i = 0; i < lines.length; i++) {
       const match = regex.exec(lines[i]);
       if (match) {
         const before = lines[i];
         const after = lines[i].replace(pattern, replacement);
         changes.push({ lineNumber: i + 1, before, after });

         if (!params.dryRun) {
           modified = modified.replace(match[0], replacement);
         }
       }
     }

     if (params.dryRun) {
       return formatDryRunOutput(changes);
     } else {
       await fs.writeFile(params.path, modified, "utf-8");
       return { modified, changesMade: changes.length };
     }
   };
   ```

3. **Format dry-run output:**
   ```typescript
   function formatDryRunOutput(changes: Array<{lineNumber: number, before: string, after: string}>): string {
     return `Dry-run mode: No files will be modified.
   ```

File: ${filePath}
${changes.map(change =>
`  Line ${change.lineNumber}: Change
    Before: ${change.before}
    After:  ${change.after}`
).join('\n')}

${changes.length} replacements would be made.`;
}

````

### Testing Requirements

- [ ] Test dry-run doesn't modify file
- [ ] Test dry-run shows correct preview
- [ ] Test with multiple matches
- [ ] Test with no matches
- [ ] Test with large files (performance)
- [ ] Test non-dry-run still modifies files correctly
- [ ] Test safety limits (> 1000 matches warning)

---

## Phase 6: Line-Level Operations

### Files to Modify

- `packages/shoggoth/src/tools/builtin-search-replace.ts` (add `deleteLines` and `replaceRange` parameters)
- Optionally: `packages/shoggoth/src/tools/builtin-write.ts` (add range support)

### Implementation Steps

#### Delete Lines Feature

```typescript
execute: async (params) => {
const content = await fs.readFile(params.path, 'utf-8');
const lines = content.split('\n');

let deleteSet: Set<number>;
if (params.deleteLines) {
 deleteSet = new Set(params.deleteLines.map(ln => Math.max(1, Math.min(ln, lines.length))));
} else if (params.deleteRange) {
 deleteSet = new Set(
   ...Array.from(
     { length: params.deleteRange.end - params.deleteRange.start + 1 },
     (_, i) => params.deleteRange.start + i
   )
 );
}

if (deleteSet) {
 const newLines = lines.filter((_, i) => !deleteSet.has(i + 1));
 const newContent = newLines.join('\n');

 if (!params.dryRun) {
   await fs.writeFile(params.path, newContent, 'utf-8');
 }

 return { deletedLines: deleteSet.size };
}
}
````

#### Range Replacement Feature

```typescript
execute: async (params) => {
  const content = await fs.readFile(params.path, "utf-8");
  const lines = content.split("\n");

  if (params.replaceRange) {
    const { start, end, replacement } = params.replaceRange;

    // Validate range
    if (start < 1 || end > lines.length || start > end) {
      throw new ToolError(`Invalid range: start=${start}, end=${end}, totalLines=${lines.length}`);
    }

    // Convert replacement to array if string
    const replacementLines = Array.isArray(replacement) ? replacement : [replacement];

    const beforeLines = lines.slice(0, start - 1);
    const afterLines = lines.slice(end);
    const newLines = [...beforeLines, ...replacementLines, ...afterLines];
    const newContent = newLines.join("\n") + (content.endsWith("\n") ? "\n" : "");

    if (!params.dryRun) {
      await fs.writeFile(params.path, newContent, "utf-8");
    }

    return { replacedLines: end - start + 1 };
  }
};
```

### Testing Requirements

- [ ] Test single line deletion
- [ ] Test range deletion
- [ ] Test multiple non-contiguous line deletions
- [ ] Test range replacement with string
- [ ] Test range replacement with array
- [ ] Test edge case: delete entire file
- [ ] Test edge case: replace with empty
- [ ] Test out-of-range error handling
- [ ] Test line ending preservation
- [ ] Test trailing newline preservation
- [ ] Test dry-run mode

---

## Phase 7: Documentation Updates

### Focus

Comprehensive documentation for all new and modified tools to ensure users can effectively adopt the new features.

### Tasks

- Update `docs/tools/builtin-read.md` with new flags, output formats, and edge cases
- Create `docs/tools/builtin-search.md` with full feature documentation and examples
- Update `docs/tools/builtin-search-replace.md` with deprecation notices for old `file` parameter
- Create `docs/tools/builtin-replace.md` documenting the renamed tool
- Update `docs/tools/builtin-exec.md` with multiline string usage examples
- Add documentation for dry-run mode behavior and safety features
- Document line-level operation syntax, constraints, and examples
- Create migration guide (`docs/migrations.md`) for parameter renames (`file` → `path`)
- Update API reference with all new parameters and default values
- Add usage examples for each new feature
- Document all error message formats with examples
- Include troubleshooting section for common issues

### Files to Modify/Create

- `docs/tools/builtin-read.md` (update)
- `docs/tools/builtin-search.md` (new)
- `docs/tools/builtin-search-replace.md` (update with deprecation notices)
- `docs/tools/builtin-replace.md` (new)
- `docs/tools/builtin-exec.md` (update)
- `docs/migrations.md` (new)
- `docs/tools/README.md` (update tool listing)

### Testing Requirements

- [ ] Verify all documentation builds correctly
- [ ] Check code examples work as documented
- [ ] Update API reference to reflect new parameters
- [ ] Validate migration guide clarity with real scenarios
- [ ] Ensure all tool signatures match actual implementation
- [ ] Proofread for consistency in terminology and examples

### Documentation Standards

- Each tool doc should have: description, parameters table, examples, error handling, and edge cases
- Migration guide should include: what changed, how to migrate, timeline
- API reference should be machine-readable (OpenAPI-like) where applicable
- Examples should be copy-paste ready and demonstrate real use cases

---

## Development Order

Recommended order for maximum efficiency:

1. **Phase 3** - Easy, foundational improvement (better errors)
2. **Phase 1** - Straightforward enhancement (read formatting)
3. **Phase 2a** - Create new search tool
4. **Phase 2b** - Modify replace tool (parameter rename)
5. **Phase 5** - Build on replace tool (dry-run)
6. **Phase 6** - Build on replace tool (line operations)
7. **Phase 4** - Can be done anytime (standalone)
8. **Phase 7** - Documentation (can start after Phase 2a, complete after all implementation)

---

## Release Strategy

- Release all phases together as a single version bump
- Document all changes in release notes
- Provide migration guide if breaking changes exist
- Consider feature flags for gradual rollout if needed

---

## Rollback Plan

- All changes are additive (new parameters)
- Old parameters remain functional with deprecation warnings
- Can revert individual phases if issues arise
- No database or config migrations required

---

## Post-Implementation Tasks

1. Update all user-facing documentation (Phase 7)
2. Add examples to tool references
3. Update API documentation
4. Write blog post/announcement for release
5. Gather user feedback after release
6. Monitor error logs for new error patterns
7. Update CHANGELOG.md with all changes

---

## Appendix: Test Cases

### Test Case Set 1: Phase 1 (Read Formatting)

```
Input: "line1\nline2\nline3\n"
Expected (lines=true): "line1\nline2\nline3\n"
Expected (lines=true, numbers=true): "1: line1\n2: line2\n3: line3\n"
```

### Test Case Set 2: Phase 3 (Regex Errors)

```
Pattern: "[abc"
Expected: Clear error indicating unclosed bracket at position 4
```

### Test Case Set 3: Phase 5 (Dry Run)

```
File: "test.txt"
Content: "const x = 10;\nconst y = 20;"
Pattern: "const \w = \d+"
Replacement: "const $1 = 100;"
Dry-run: true
Expected: Show 2 proposed changes, no file modification
```

### Test Case Set 4: Phase 6 (Range Operations)

```
File: "config.yaml"
Content: "key1: val1\nkey2: val2\nkey3: val3\n"
Operation: Replace range 1-2 with "newKey: newVal"
Expected: "newKey: newVal\nkey3: val3\n"
```

---

## Appendix B: Documentation Checklist for Phase 7

### Per-Tool Documentation

- [ ] **`builtin-read`:**
  - [ ] New `lines` parameter description and examples
  - [ ] New `lineNumbers` parameter description and examples
  - [ ] Large file handling explanation
  - [ ] Output format examples for all flag combinations

- [ ] **`builtin-search` (new):**
  - [ ] Complete parameter documentation
  - [ ] Return value structure
  - [ ] Usage examples with various patterns
  - [ ] Performance considerations
  - [ ] Error handling examples

- [ ] **`builtin-search-replace` / `builtin-replace`:**
  - [ ] Deprecation notice for `file` parameter
  - [ ] New `path` parameter documentation
  - [ ] Dry-run mode examples
  - [ ] Line-level operations examples
  - [ ] Regex error message examples

- [ ] **`builtin-exec`:**
  - [ ] Multiline string handling documentation
  - [ ] Shell escaping guidelines
  - [ ] Example with commit messages
  - [ ] Example with script content

### Cross-Cutting Documentation

- [ ] **Migration guide:**
  - [ ] What changed (parameter renames)
  - [ ] How to migrate (`file` → `path`)
  - [ ] Timeline for deprecation
  - [ ] Backwards compatibility notes

- [ ] **API reference:**
  - [ ] All new parameters listed
  - [ ] Default values documented
  - [ ] Type information
  - [ ] Constraints and limits

- [ ] **Examples repository:**
  - [ ] Real-world scenarios for each feature
  - [ ] Copy-paste ready examples
  - [ ] Common pitfalls and solutions

- [ ] **Troubleshooting guide:**
  - [ ] Common error messages and fixes
  - [ ] Performance tips
  - [ ] Edge case handling
