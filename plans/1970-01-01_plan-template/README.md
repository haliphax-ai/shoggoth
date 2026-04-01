---
date: 2026-04-01
status: planned
completed: never
---

# Plan Title

> This file is a template and reference for writing Shoggoth implementation plans. Copy it into a new directory under `plans/` when starting a plan. When the plan is complete, move the directory to `plans/done/` and update the frontmatter.

## Frontmatter

```yaml
---
date: 2026-04-01       # Date the plan was created (YYYY-MM-DD)
status: planned         # planned | in-progress | complete | abandoned
completed: never        # Date completed (YYYY-MM-DD), or "never" if not yet done
---
```

## Summary

One or two sentences describing what this plan accomplishes and why. This should be enough for someone skimming the plans directory to decide whether to read further.

## Motivation

Why does this change exist? What problem does it solve, what limitation does it remove, or what capability does it add? Keep it grounded — no aspirational fluff.

## Design

The technical design. Include type definitions, data flow, architecture decisions, and tradeoffs. Use code blocks for interfaces and type signatures. Diagrams are welcome when they clarify structure.

Subsections should cover:
- Core data structures and interfaces
- How the feature integrates with existing code
- Edge cases and failure modes
- Security considerations (if applicable)

## Implementation Phases

Break the work into ordered phases. Each phase should be independently shippable and testable. Include the files that will be touched.

### Phase 1: Description

- What this phase does
- Key changes

**Files:**
- `packages/foo/src/bar.ts`
- `packages/foo/src/baz.ts`

### Phase 2: Description

- What this phase does
- Key changes

**Files:**
- `packages/foo/src/qux.ts`

## Testing Strategy

What needs to be tested and how. List the key test scenarios. Unit tests, integration tests, and manual verification steps as appropriate.

## Considerations

Gotchas, deferred work, hidden complexity, and open questions. This section captures things that aren't blockers but should be kept in mind during implementation or revisited later.

- Known edge cases that aren't addressed in this plan
- Work intentionally deferred to a future plan
- Areas where the design might not scale or where assumptions could break
- Dependencies on external systems or unfinished features
- Security, performance, or compatibility concerns worth flagging

## Migration

How existing data, state, or configuration is affected. If nothing needs migration, say so explicitly. If state files are invalidated, note the wipe-on-deploy expectation.

## Plan Assets

Plans can include supporting files alongside the README — schemas, config samples, API specs, test fixtures, or anything that helps communicate the design. Reference them with relative paths:

- [`example-schema.json`](example-schema.json) — an example JSON schema showing the proposed data structure
