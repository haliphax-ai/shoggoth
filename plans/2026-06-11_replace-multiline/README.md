---
date: 2026-06-11
completed: 2026-06-11
---

---

# Replace Tool Multiline Support

## Overview

This plan implements multiline regex support for the `builtin-replace` tool to fix a critical limitation where users cannot pass `\n` (newline) in regex patterns.

## Problem Statement

The current `builtin-replace` tool has two key limitations:

1. **Multiline regex not supported**: The regex patterns are constructed without the `m` flag, preventing proper handling of newline characters and line boundary anchors (`^`, `$`)
2. **Redundant parameter requirement**: The `pattern` parameter is required even when using line-range operations (`deleteLine`, `deleteRange`, `replaceRange`) where it's not needed

## Solution Design

### 1. Add `multiline` parameter

- Add a new boolean parameter `multiline` (default: `false`)
- When `multiline` is `true`, add the `m` flag to regex patterns: `regexFlags = caseSensitive ? "gm" : "gmi"`

### 2. Make `pattern` conditionally required

- When using line-range operations (`deleteLine`, `deleteRange`, `replaceRange`), `pattern` should be optional
- When performing pattern-based replacement, `pattern` remains required

### 3. Update tool schema

- Add `multiline` parameter to the tool's JSON schema in `packages/mcp-integration/src/builtin-shoggoth-tools.ts`
- Make `pattern` conditionally required based on the operation type

## Files to Modify

1. **packages/mcp-integration/src/builtin-shoggoth-tools.ts** - Tool schema definition
2. **packages/daemon/src/sessions/builtin-handlers/replace-handler.ts** - Handler implementation
3. **packages/daemon/test/builtin-handlers/replace-handler.test.ts** - New test file

## Testing Strategy

- Red/green TDD approach
- Test multiline pattern replacement with `\n` in patterns
- Test that `pattern` is not required for line-range operations
- Test that `m` flag is properly applied
- Ensure no regressions in existing functionality

## Implementation Phases

1. **Phase 1**: Create test file with failing tests
2. **Phase 2**: Update tool schema to add `multiline` parameter
3. **Phase 3**: Update handler to support multiline regex
4. **Phase 4**: Make `pattern` conditionally required
5. **Phase 5**: Run full test suite and typecheck

## References

- Issue: Builtin-replace tool cannot handle multiline patterns
- Related: Tool parameter redundancy for line-range operations
