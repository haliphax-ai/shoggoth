---
date: 2026-10-10
completed: 2026-10-10
---

# OOB Turn Cancellation

## Summary

Preserve cancelled model-turn state through OOB delivery so an operator abort
does not start a structured-output repair turn. Resolves Issue #379.

## Design

The session core returns an explicit cancellation marker alongside preserved
partial text. Both timer and subagent-result delivery pass that marker to the
shared OOB handler, which stops before parsing or routing cancelled output.
The same check applies to repair-turn results. Existing platform binding
resolution controls whether the operator receives a short cancellation notice.
Do not interpret model text as cancellation or disable genuine repair retries.

## Testing Strategy

Red/green tests exercise the real session/tool loop with deterministic aborts,
including initial and repair turns, attached and unattached sessions, partial
valid JSON, repeated abort, and subsequent successful delivery. Run the full
project suite, typecheck, formatting, lint and Linux isolation checks.

## Migration

No database or configuration changes. Existing in-band partial text and
workflow throw-on-error behavior remain intact.

## References

- [Issue #379](https://github.com/haliphax-ai/shoggoth/issues/379)
- [Specification](spec.md)
- [Implementation](implementation.md)
