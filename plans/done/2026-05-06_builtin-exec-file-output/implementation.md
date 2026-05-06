# Implementation Phases

## Phase 1: Parameter Validation

- Add `stdoutFile`, `stderrFile`, `outputFile` to ExecArgs interface
- Implement mutual exclusivity validation
- Add foreground-only enforcement

## Phase 2: File Writing Logic

- Implement file writing for combined output (`outputFile`)
- Implement separate file writing for stdout/stderr
- Ensure files are created even when empty
- Handle non-zero exit codes gracefully

## Phase 3: Path Validation

- Implement workspace boundary validation
- Prevent directory traversal attacks
- Validate path format and permissions

## Phase 4: Result Formatting

- Include file paths in result when used
- Maintain backward compatibility for inline output

## Phase 5: Testing

- Unit tests for parameter validation
- Integration tests for file writing
- Edge case testing (empty output, non-zero exit codes)
- Path validation tests

## Phase 6: Documentation

- Update builtin-exec.md with new parameters
- Add File Output section with examples
- Update plan frontmatter to mark complete
