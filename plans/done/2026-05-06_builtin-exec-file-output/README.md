---
date: 2026-05-06
completed: 2026-05-06
---

# builtin-exec File Output Feature

## Summary

Adds file output capabilities to the `builtin-exec` tool, allowing stdout/stderr to be written to workspace files instead of being returned inline.

## Motivation

The `builtin-exec` tool previously returned all output inline, which could cause issues with large outputs and made it difficult to process output files with other tools. This feature allows users to redirect output to files for later processing.

## Design

The feature adds three new parameters to `builtin-exec`:

- `stdoutFile`: Write stdout to this workspace-relative file
- `stderrFile`: Write stderr to this workspace-relative file
- `outputFile`: Write combined stdout+stderr to this file (mutually exclusive with stdoutFile/stderrFile)

Key implementation details:

- File output is foreground-only (cannot be combined with background/yieldMs)
- Files are created even if output is empty (zero-byte file)
- Files are written even on non-zero exit codes
- Paths are validated to stay within workspace boundary

## Testing Strategy

The feature includes comprehensive tests covering:

- Parameter validation (mutually exclusive combinations)
- File writing for stdout, stderr, and combined output
- Edge cases like empty output and non-zero exit codes
- Path validation to prevent directory traversal
- Integration with existing exec handler

## Considerations

- File output cannot be combined with background execution
- The feature is implemented but documentation was pending completion
- No breaking changes to existing functionality

## Migration

No migration needed - this is a purely additive feature.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
