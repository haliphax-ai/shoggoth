---
date: 2026-05-05
completed: never
---

# Builtin Tool Enhancements Plan

## Overview

This plan addresses GitHub Issue #29: "Enhance builtin tools for better file editing experience". The goal is to improve the developer experience when using builtin tools for file operations by splitting confusing functionality, adding formatting options, and providing better error messages.

## Problem Statement

Current builtin tools have several pain points identified through developer feedback:

- `builtin-read` returns files as single-line strings, making output hard to read
- `builtin-search-replace` combines search and replace in one tool with inconsistent argument naming
- Regex errors lack helpful context about what failed
- Multiline content is difficult to pass to tools
- No dry-run capability to preview changes
- No granular line/range operations, requiring complex regex workarounds

## Goals

1. Improve readability of file content output
2. Separate search and replace concerns into distinct tools
3. Provide actionable error messages for regex failures
4. Support multiline content more naturally
5. Enable safe preview of replacements before execution
6. Simplify targeted edits with line-level operations
7. Ensure comprehensive documentation for all new and modified tools

## Non-Goals

- Changing the core functionality of existing tools beyond the specified enhancements
- Replacing existing tools with entirely new abstractions
- Adding completely unrelated features not mentioned in the issue

## Implementation Phases

This plan is broken into 7 independent phases, each addressing one enhancement. Each phase can be developed, tested, and deployed independently.

### Phase 1: Formatted Output for `builtin-read`

**Focus:** Improve file content display

**Tasks:**

- Add `--lines` flag to split output by line
- Add `--line-numbers` flag for numbered output
- Consider defaulting to line-split for better UX

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-read.ts`

**Testing:**

- Test with various file sizes and content types
- Verify line-splitting handles edge cases (empty lines, special characters)

### Phase 2: Split `builtin-search-replace`

**Focus:** Separate concerns and normalize APIs

**Tasks:**

- Create `packages/shoggoth/src/tools/builtin-search.ts`
- Modify `packages/shoggoth/src/tools/builtin-search-replace.ts` to keep only replace functionality
- Rename `file` parameter to `path` across both tools for consistency
- Update documentation

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-search.ts` (new)
- `packages/shoggoth/src/tools/builtin-search-replace.ts` (modified)
- `packages/shoggoth/src/tools/index.ts` (updates)
- Documentation files

**Testing:**

- Verify search functionality in new tool
- Verify replace functionality retained in modified tool
- Ensure API consistency

### Phase 3: Improved Regex Error Messages

**Focus:** Better developer feedback on parsing failures

**Tasks:**

- Catch regex compilation errors in both search and replace tools
- Extract position and context from error messages
- Format user-friendly error output showing the problematic pattern

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-search.ts`
- `packages/shoggoth/src/tools/builtin-search-replace.ts`

**Testing:**

- Test with various invalid regex patterns
- Verify error messages are actionable and clear

### Phase 4: Multiline String Support in `builtin-exec`

**Focus:** Easier handling of multiline content

**Tasks:**

- Document or implement JSON array syntax for multiline argv
- Optionally add `--multiline` flag for raw multiline strings
- Consider automatic detection of multiline content

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-exec.ts`
- Documentation

**Testing:**

- Test with commit messages, scripts, and other multiline content
- Verify proper escaping and delimiting

### Phase 5: Dry-Run Mode for Replacements

**Focus:** Safe preview of changes

**Tasks:**

- Add `--dry-run` or `--preview` flag to `builtin-replace`
- Output proposed changes without modifying files
- Include line numbers and context around replacements
- Distinguish between "would match" and "would replace"

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-search-replace.ts`

**Testing:**

- Verify no file modifications in dry-run mode
- Check output includes clear preview of changes
- Test with various regex patterns

### Phase 6: Line-Level Operations

**Focus:** Simplify targeted edits

**Tasks:**

- Add `--delete-lines` option to `builtin-search-replace` or create `builtin-delete-lines`
- Add `--replace-range` option for range-based replacements
- Consider adding line range support to `builtin-write`
- Ensure line numbers are 1-indexed and clearly documented

**Files to Touch:**

- `packages/shoggoth/src/tools/builtin-search-replace.ts` (new options)
- `packages/shoggoth/src/tools/builtin-write.ts` (range support)
- Documentation

**Testing:**

- Test line deletion on various files
- Test range replacements at boundaries
- Verify error handling for out-of-range operations

### Phase 7: Documentation Updates

**Focus:** Comprehensive documentation for all new and modified tools

**Tasks:**

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

**Files to Modify/Create:**

- `docs/tools/builtin-read.md` (update)
- `docs/tools/builtin-search.md` (new)
- `docs/tools/builtin-search-replace.md` (update with deprecation notices)
- `docs/tools/builtin-replace.md` (new)
- `docs/tools/builtin-exec.md` (update)
- `docs/migrations.md` (new)
- `docs/tools/README.md` (update tool listing)

**Testing:**

- Verify all documentation builds correctly
- Check code examples work as documented
- Update API reference to reflect new parameters
- Validate migration guide clarity with real scenarios
- Ensure all tool signatures match actual implementation

## Success Criteria

- Each phase completes with all tests passing
- All enhancement goals are met
- Backwards compatibility preserved (no breaking changes)
- Comprehensive documentation (Phase 7) completed
- Migration guide clear and actionable
- Negative testing confirms robust error handling

## Risk Assessment

| Risk                                    | Likelihood | Impact | Mitigation                                                           |
| --------------------------------------- | ---------- | ------ | -------------------------------------------------------------------- |
| Breaking existing usage patterns        | Low        | Medium | Maintain backwards compatibility, deprecate old params with warnings |
| Complex line-number handling bugs       | Medium     | Medium | Extensive unit tests, edge case coverage                             |
| Performance regression with large files | Low        | Medium | Add streaming or chunked processing if needed                        |
| Multiline string escaping issues        | Medium     | Low    | Thorough testing with various delimiters                             |
| Documentation gaps or confusion         | Medium     | Low    | Peer review of docs, testing migration guide with first users        |

## Dependencies

- None (self-contained improvements)
- Testing dependencies already in place
- No external API changes required

## Timeline

Target completion: 2.5 weeks (documentation adds half week)

- Week 1: Phases 1-3 (output formatting, API consistency, error handling)
- Week 2: Phases 4-6 (multiline support, dry-run, line operations)
- Week 2.5: Phase 7 (comprehensive documentation)

## Related Issues

- GitHub Issue #29 (source)

## Open Questions

1. Should line-splitting be the default for `builtin-read`, or remain opt-in?
2. Should line deletion be a separate tool or an option of `builtin-search-replace`?
3. What's the best API for specifying line ranges (inclusive/exclusive, 0-indexed vs 1-indexed)?
4. What's the deprecation timeline for the `file` parameter?

## Next Steps

1. Begin implementation of Phase 1
2. Add tests for each feature before implementation
3. Create PRs for each phase or group related phases together
4. Start Phase 7 documentation work after Phase 2a (search tool created)
5. Gather feedback on intermediate deliverables
