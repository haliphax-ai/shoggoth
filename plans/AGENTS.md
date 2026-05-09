# Plans — Agent Instructions

## Creating a Plan

1. Copy the template folder `plans/1970-01-01_plan-template/` into a new folder named `YYYY-MM-DD_slug/` where the date is today and the slug is a short kebab-case description.
2. Update the frontmatter in `README.md`: set `date` to today and `completed` to `never`.
3. Fill in each section of the templates (`README.md`, `spec.md`, `implementation.md`). Remove the instructional text as you go.
4. Add supporting assets (diagrams, etc.) alongside the template documents and reference them with relative paths.

```
plans/
  2026-04-15_my-feature/
    README.md              # Primary plan document (architecture, overview)
    spec.md                # Specification document (schema, code examples, etc.)
    implementation.md      # Implementation plan (phased implementation steps)
    architecture.svg       # Supporting asset
    glossary.md            # Complementary document
```

## Frontmatter

> This section describes the YAML frontmatter properties used in plan documents. Do not include a "Frontmatter" section in actual plans — just include the YAML block at the top of the README.

Every plan README must include YAML frontmatter:

```yaml
---
date: 2026-04-15 # Date the plan was created (YYYY-MM-DD)
completed: never # Date completed (YYYY-MM-DD), or "never"
---
```

## Writing Guidelines

- Keep the primary plan document (`README.md`) focused on architecture and a high level overview. Include the feature/change motivation, design, testing strategy, considerations, migration steps (if any), and references to other plan documents/assets.
- Break implementations (`implementation.md`) into chunked phases so they are easier to delegate to subagents.
- Each implementation phase should be independently shippable and testable.
- Structure phases so additive work (new modules, new files) comes before integration work (modifying existing code). This prevents cascading breakage across phases.
- If a phase introduces a breaking change (e.g. replacing a schema), that phase owns fixing ALL tests broken by the change — not a later phase.
- List the files each phase will touch.
- Include type signatures and interfaces, code examples, etc. in a separate `spec.md` document.
- Binary assets (images, etc.) should be kept small to avoid bloating the git repo. Skip including any if they do not provide useful context.

## Updating a Plan

When the design evolves during implementation, update the plan document to reflect the changes. Add an addendum section at the end for post-implementation refinements rather than rewriting the original design — this preserves the decision history.

## Completing a Plan

When all phases have been implemented:

1. Update the frontmatter: set `completed` to today's date.
2. Move the plan folder to `plans/done/`.

```
plans/2026-04-15_my-feature/ → plans/done/2026-04-15_my-feature/
```

## Abandoning a Plan

If a plan is no longer relevant, delete its plan folder.
