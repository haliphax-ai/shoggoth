# Implementation Plan

## Phase 1: Create Failing Tests (RED)

### Files to Create

- `packages/daemon/test/builtin-handlers/replace-handler.test.ts`

### Test Cases to Implement

1. **Multiline pattern replacement**: Test that `\n` in patterns works with `multiline: true`
2. **Pattern not required for line operations**: Test that `deleteLine` works without `pattern`
3. **m flag application**: Test that `^` and `$` match line boundaries with `multiline: true`
4. **Regression tests**: Ensure existing functionality still works

### Expected Result

All new tests should fail (RED state)

## Phase 2: Update Tool Schema

### Files to Modify

- `packages/mcp-integration/src/builtin-shoggoth-tools.ts`

### Changes

1. Add `multiline` parameter to the `replace` tool's `inputSchema`
2. Update description for `multiline` parameter
3. No changes to `required` array (keep `["path"]`)

### Expected Result

Schema now includes `multiline` parameter

## Phase 3: Update Handler Implementation

### Files to Modify

- `packages/daemon/src/sessions/builtin-handlers/replace-handler.ts`

### Changes

1. Extract `multiline` parameter from args (default: `false`)
2. Update regex flag logic to include `m` flag when `multiline` is `true`
3. Update pattern validation to make `pattern` optional when line operations are used
4. Update error messages for missing pattern

### Code Changes

```typescript
// Extract multiline parameter
const multiline = args.multiline === true;

// Update regex flags
const regexFlags = caseSensitive ? (multiline ? "gm" : "g") : multiline ? "gmi" : "gi";

// Update pattern requirement check
const hasLineOperations =
  deleteLines.length > 0 || deleteLine !== undefined || deleteRange || replaceRange;
if (!hasLineOperations && pattern == null) {
  return { resultJson: JSON.stringify({ error: "pattern is required for replacement" }) };
}
```

### Expected Result

Handler supports multiline regex and makes pattern optional for line operations

## Phase 4: Run Tests and Typecheck

### Commands to Run

1. `npm run typecheck` - Ensure no TypeScript errors
2. `npm test` - Run all tests including new ones

### Expected Result

- All tests pass (GREEN state)
- No type errors
- Existing functionality preserved

## Phase 5: Create Feature Branch and Commit

### Git Commands

```bash
git checkout -b feat/replace-multiline
git add .
git commit -m "feat: add multiline regex support to builtin-replace tool"
git push -u origin feat/replace-multiline
gh pr create --title "Add multiline regex support to builtin-replace tool" --body "..."
```

### Commit Strategy

1. Phase 1: "test: add failing tests for multiline replace"
2. Phase 2: "feat: add multiline parameter to replace tool schema"
3. Phase 3: "feat: implement multiline regex support in replace handler"
4. Phase 4: "fix: make pattern optional for line-range operations"

## Rollback Plan

If issues arise:

1. Revert to previous commit on main branch
2. Keep feature branch for investigation
3. Fix issues in feature branch before merging
