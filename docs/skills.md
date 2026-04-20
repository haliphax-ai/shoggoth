# Skills Reference (`@shoggoth/skills`)

This document is a source-level reference for the `@shoggoth/skills` package. Skills are markdown files with YAML-like frontmatter discovered by scanning configured directory roots, exposed to agents via the `builtin-skills` tool (see [MCP Integration — Built-in Tools](mcp-integration.md#built-in-shoggoth-tools)).

---

## Overview

Skills are Markdown files (`.md`) with optional YAML-like frontmatter that provide reusable knowledge, instructions, or reference material to agents at runtime. They are discovered by scanning configured directory roots and presented to agents via the `builtin-skills` tool, which supports listing, reading, and searching skills.

Key characteristics:

- Skills are static content — they do not execute code or register hooks.
- Each skill has a unique ID (explicit or auto-derived from its file path).
- Skills can be disabled at the file level (frontmatter) or globally via config.
- Agents interact with skills through the `builtin-skills` tool actions: `list`, `path`, and `read`.

---

## Skill Loading Order

Understanding the loading order is critical because when multiple skills share the same ID, the **last one loaded wins**.

### Resolution Rules

1. Configured `skills.scanRoots` paths are resolved relative to `/var/lib/shoggoth` (absolute paths pass through unchanged).
2. The default config is `scanRoots: ["skills"]` which resolves to `/var/lib/shoggoth/skills` for system-level skills.
3. Roots are scanned in configured array order (first element scanned first).
4. The current agent's workspace `skills/` subfolder (e.g. `/var/lib/shoggoth/workspaces/<agent>/skills/`) is **always appended as the last root automatically**.
5. Within each root, files are sorted lexicographically for deterministic ordering.
6. Skills are deduplicated by ID using a Map (last write wins).

### Override Semantics

Because workspace skills load last, they override system skills with the same ID:

```
System skill:    /var/lib/shoggoth/skills/docker.compose-debug.md  (loaded first)
Workspace skill: /var/lib/shoggoth/workspaces/main/skills/docker.compose-debug.md  (loaded last — wins)
```

This allows agents or operators to customize or replace system-level skills on a per-workspace basis without modifying the shared skill directory.

### Loading Sequence Diagram

```
scanRoots[0]  →  scanRoots[1]  →  ...  →  scanRoots[N]  →  workspace/skills/
   ↓                 ↓                          ↓                    ↓
(sorted files)  (sorted files)           (sorted files)       (sorted files)
                                                                     ↑
                                                              LAST = highest priority
```

---

## Skill File Format

A skill is any `.md` file found under a configured scan root. The file may optionally begin with YAML-like frontmatter delimited by `---` fences:

```markdown
---
id: my-custom-skill
title: My Custom Skill
description: One-line summary for search matching
enabled: true
tags: [typescript, testing, utilities]
category: dev-tools
---

Body content of the skill goes here. This is the part
presented to agents when they read the skill.
```

### Frontmatter Fields

| Field         | Type              | Default                        | Description |
|---------------|-------------------|--------------------------------|-------------|
| `id`          | `string`          | Auto-derived from file path    | Unique identifier. If omitted, generated from the file's path relative to its scan root (e.g. `subdir/my-skill.md` → `subdir.my-skill`). |
| `title`       | `string`          | Falls back to `name`, then `id`| Human-readable display title. The `name` field is accepted as an alias. |
| `description` | `string`          | `null`                         | One-line description used for search relevance scoring. |
| `enabled`     | `boolean`         | `true`                         | Set to `false` to disable the skill at the file level. Accepts `true`/`false`, `yes`/`no`, `1`/`0`. |
| `tags`        | `string[]` (YAML) | `[]`                           | Freeform tags for filtering. Parsed from inline YAML array syntax `[tag1, tag2]` or comma-separated values. Normalized to lowercase. |
| `category`    | `string`          | `null`                         | Broad grouping label (e.g. `utilities`, `dev-tools`, `integrations`). Normalized to lowercase. |

### Frontmatter Parsing Rules

- The parser is minimal and line-oriented — it is **not** a full YAML parser.
- Each line inside the `---` fences is matched against the pattern `key: value` where keys are alphanumeric (plus `_`, `.`, `-`).
- Values are taken as raw strings; boolean coercion and tag array parsing happen in dedicated helpers.
- If the file does not start with `---`, the entire content is treated as the body with no frontmatter fields.

### Auto-Generated Skill IDs

When no `id` field is present in frontmatter, the ID is derived from the file path relative to its scan root:

1. Compute the relative path from the scan root to the file.
2. Strip the `.md` extension.
3. Replace all `/` separators with `.`.

Example: scan root `/var/lib/shoggoth/skills`, file `/var/lib/shoggoth/skills/aws/lambda-deploy.md` → id `aws.lambda-deploy`.

---

## Skill Discovery

Skills are discovered by the `scanSkillDirectories()` function:

1. **Scan roots** are resolved from `config.skills.scanRoots`. Each root path is resolved relative to `/var/lib/shoggoth` (absolute paths are used as-is).
2. The agent's workspace `skills/` subfolder is appended as the final root.
3. Each root is recursively walked for `*.md` files.
4. Files within each root are sorted lexicographically for deterministic ordering.
5. Frontmatter is parsed from each file to extract metadata.
6. A skill is marked `enabled: false` if **either**:
   - The frontmatter `enabled` field is `false`, **or**
   - The skill's ID appears in `config.skills.disabledIds`.
7. Skills are stored in a Map keyed by ID — when duplicate IDs are encountered, the last one loaded replaces the earlier entry.

The result is an array of `SkillRecord` objects:

```typescript
interface SkillRecord {
  readonly id: string;
  readonly title: string;
  readonly absolutePath: string;
  readonly enabled: boolean;
  readonly tags: readonly string[];
  readonly category: string | null;
  readonly description: string | null;
}
```

---

## Skill Search

The `searchSkills()` function provides filtering and ranked search over a list of `SkillRecord`s.

### Search Parameters

```typescript
interface SkillSearchParams {
  query?: string | null;      // Free-text search
  tags?: readonly string[];   // AND-logic tag filter
  category?: string | null;   // Exact category match
  limit?: number;             // Max results (default: 10)
  offset?: number;            // Pagination offset (default: 0)
}
```

### Search Behavior

- **Tag filter**: AND logic — a skill must have *all* specified tags to match.
- **Category filter**: Exact match (case-insensitive after normalization).
- **Query scoring**: When a `query` is provided, skills with zero relevance are excluded. Relevance is computed via case-insensitive substring matching with weighted fields:

| Field              | Weight |
|--------------------|--------|
| `id` and `title`   | 3×     |
| `description`      | 2×     |
| `tags` and `category` | 1× |

- Results are sorted by score descending, then by `id` ascending for stable ordering.
- Pagination is applied via `offset` and `limit` after sorting.

### Search Result

```typescript
interface SkillSearchResult {
  readonly skill: SkillRecord;
  readonly score: number;       // 0 when no query provided
}
```

---

## Configuration

Skills are configured via the `ShoggothSkillsConfig` schema (defined in [`@shoggoth/shared`](shared.md#configuration-schema)):

```typescript
interface ShoggothSkillsConfig {
  scanRoots: string[];    // Directories scanned for *.md skill files
  disabledIds: string[];  // Skill IDs to force-disable regardless of file-level enabled field
}
```

### Default Config

```json
{
  "skills": {
    "scanRoots": ["skills"],
    "disabledIds": []
  }
}
```

With the default `scanRoots: ["skills"]`, the resolved path is `/var/lib/shoggoth/skills`.

### Configuration Helpers

| Function | Purpose |
|----------|---------|
| `resolveSkillScanRoots(config)` | Resolves `config.skills.scanRoots` paths relative to `/var/lib/shoggoth`. Appends the workspace `skills/` subfolder as the final root. |
| `listSkillsForConfig(config)` | Full scan: resolves roots, applies `disabledIds`, returns all `SkillRecord`s. |
| `skillAbsolutePathById(config, id)` | Looks up a single skill's absolute file path by its ID. Returns `undefined` if not found. |

### Disabling Skills via Config

Add skill IDs to `skills.disabledIds` to override the file-level `enabled` field:

```json
{
  "skills": {
    "scanRoots": ["skills"],
    "disabledIds": ["docker.compose-debug", "aws.lambda-deploy"]
  }
}
```

This overrides the file-level `enabled` field — even if the file says `enabled: true`, the skill will be disabled.

---

## Package Exports

The public API exported from `@shoggoth/skills`:

```typescript
// Frontmatter utilities
parseBoolField, parseMarkdownFrontmatter

// Skill scanning
scanSkillDirectories
type SkillRecord

// Skill search
searchSkills
type SkillSearchParams, SkillSearchResult

// Config-level skill helpers
listSkillsForConfig, resolveSkillScanRoots, skillAbsolutePathById
```

---

## Quick-Start Example

Create a `.md` file under any configured scan root (e.g. `/var/lib/shoggoth/skills/` or your workspace's `skills/` directory):

```markdown
---
id: docker.compose-debug
title: Debug Docker Compose Issues
description: Step-by-step guide for troubleshooting docker-compose failures
tags: [docker, debugging, containers]
category: dev-tools
enabled: true
---

When a `docker-compose up` command fails, follow these steps:

1. Check container logs: `docker-compose logs <service>`
2. Verify the compose file syntax: `docker-compose config`
3. Inspect network connectivity between services
4. Ensure all referenced images exist and are pullable
```

Agents can then interact with this skill via the `builtin-skills` tool:

- `list` — returns all skill records with metadata
- `path` — resolves the absolute file path for a skill ID
- `read` — returns the skill's file path and full content

---

## See Also

- [Daemon](daemon.md) — loads skills at startup, exposes via builtin tool registry
- [MCP Integration](mcp-integration.md) — `builtin-skills` tool implementation
- [Shared](shared.md) — `ShoggothSkillsConfig` schema definition
- [Plugins](plugins.md) — plugin system (previously co-located with skills)
