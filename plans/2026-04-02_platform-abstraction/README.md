---
date: 2026-04-02
status: planned
completed: never
---

# Platform Abstraction & URN Restructure

## Summary

Restructure agent session URNs to include a resource type segment, introduce a platform registry for schema and URN validation, and decouple platform-specific code from daemon core. This is prerequisite work before adding any platform beyond Discord.

## Motivation

The current architecture has several coupling issues:

1. **URN opacity** — Session URNs like `agent:main:discord:1234567` don't indicate what the leaf represents (channel, DM, thread). Reading logs requires cross-referencing Discord snowflakes. Adding a resource type segment (`agent:main:discord:channel:1234567`) makes URNs self-describing and enables resource-type validation.

2. **Platform registration inversion** — `platform-discord/src/register.ts` exports `registerBuiltInMessagingPlatforms()`, forcing daemon core to import from a specific platform package. Platforms should export data (validators, policies); the daemon should drive registration.

3. **No platform config validation boundary** — Platform-specific config properties (Discord token, intents, routes format) are validated inline or not at all. Platforms should register schema validators for their own config subtrees.

4. **URN validation is ad-hoc** — Discord-specific URN validation lives in `messaging-urn-policy.ts` inside platform-discord, registered via a global side-effect. Platforms should register URN validators that own validation of their segment of the URN.

## Design

### URN Restructure

Current format:
```
agent:<agentId>:<platform>:<leaf>[:<childLeaf>...]
```

New format:
```
agent:<agentId>:<platform>:<resourceType>:<leaf>[:<childLeaf>...]
```

Examples:
```
# Current
agent:main:discord:1480957862858719232
agent:main:discord:1480957862858719232:a31c6359-af42-4efa-b6ea-ff102ecfce0b

# New
agent:main:discord:channel:1480957862858719232
agent:main:discord:channel:1480957862858719232:a31c6359-af42-4efa-b6ea-ff102ecfce0b
```

Resource types for Discord (initial set):
- `channel` — guild text channel
- `dm` — direct message channel

Future resource types (not implemented now, but the format supports them):
- `thread` — thread channel
- `voice` — voice channel

The resource type segment follows the same charset rules as other URN segments (`[A-Za-z0-9._-]{1,128}`).

#### ParsedAgentSessionUrn changes

```typescript
export type ParsedAgentSessionUrn = {
  readonly agentId: string;
  readonly platform: string;
  readonly resourceType: string;  // NEW
  readonly uuidChain: readonly string[];
};
```

#### Format/mint function changes

```typescript
// Current
formatAgentSessionUrn(agentId, platform, sessionLeaf)
// New
formatAgentSessionUrn(agentId, platform, resourceType, sessionLeaf)

// Current
mintAgentSessionUrn(agentId, platform)
// New
mintAgentSessionUrn(agentId, platform, resourceType)
```

### Platform Registry

A central registry in `@shoggoth/messaging` (or `@shoggoth/shared`) where platforms register their capabilities at daemon startup.

```typescript
interface PlatformRegistration {
  /** Platform identifier (e.g. "discord", "slack"). */
  readonly platformId: string;

  /** Validate platform-specific config properties. Returns errors or null. */
  readonly validateConfig?: (config: unknown) => string[] | null;

  /**
   * Validate the platform-owned portion of a session URN.
   * Receives the parsed URN with resourceType and uuidChain.
   * Returns null if valid, or an error string.
   */
  readonly validateUrn?: (parsed: {
    resourceType: string;
    uuidChain: readonly string[];
  }) => string | null;

  /** Known resource types for this platform. Used for validation and documentation. */
  readonly resourceTypes: readonly string[];

  /** URN policy (route checking, bootstrap resolution, etc.). */
  readonly urnPolicy: MessagingPlatformUrnPolicy;
}
```

Registration is driven by the daemon:

```typescript
// daemon/src/index.ts (startup)
import { discordPlatformRegistration } from "@shoggoth/platform-discord";
import { registerPlatform } from "@shoggoth/messaging";

// Register configured platforms
registerPlatform(discordPlatformRegistration);
```

Platforms export a registration object (data), not a registration function (side-effect):

```typescript
// platform-discord/src/platform-registration.ts
export const discordPlatformRegistration: PlatformRegistration = {
  platformId: "discord",
  resourceTypes: ["channel", "dm"],
  validateConfig: validateDiscordConfig,
  validateUrn: validateDiscordUrn,
  urnPolicy: discordUrnPolicy,
};
```

### Config Validation Boundary

Shared config properties (routes structure, agent list, model config) remain in the core schema. Platform-specific properties are validated by the platform's registered `validateConfig`:

```json
{
  "agents": {
    "list": {
      "main": {
        "platforms": {
          "discord": {
            "token": "...",
            "routes": [...]
          }
        }
      }
    }
  }
}
```

Core validates the structure of `agents.list.main.platforms` (must be an object with known platform keys). The `discord` subtree is passed to Discord's `validateConfig` for platform-specific validation (token format, route shape, intent flags, etc.).

## Implementation Phases

These phases are designed for sequential fan-out execution.

### Phase 1: URN Parser & Formatter

Update the URN parser and all format/mint functions to include `resourceType`. This is the foundation — everything else depends on it.

- Add `resourceType` to `ParsedAgentSessionUrn`
- Update `parseAgentSessionUrn` to extract resource type (4th segment)
- Update `formatAgentSessionUrn`, `mintAgentSessionUrn`, `mintSubagentSessionUrnFromParent`, `defaultPrimarySessionUrnForAgent` signatures
- Update `resolveTopLevelSessionUrn`, `isSubagentSessionUrn` for new segment position
- Add `isValidResourceType` validator (charset check)
- Update `SHOGGOTH_SESSION_URN_TAIL_SEGMENT_RE` usage and docs

**Files:**
- `packages/shared/src/session-urn.ts`

### Phase 2: Platform Registry

Create the platform registry interface and registration API. Remove the old `registerBuiltInMessagingPlatforms` pattern.

- Define `PlatformRegistration` interface
- Implement `registerPlatform()` and `getPlatformRegistration()` in messaging package
- Migrate existing `MessagingPlatformUrnPolicy` into the new `PlatformRegistration` structure
- Remove `registerMessagingPlatformUrnPolicy` (replaced by `registerPlatform`)
- Remove `getMessagingPlatformUrnPolicy` (replaced by `getPlatformRegistration().urnPolicy`)

**Files:**
- `packages/messaging/src/platform-registry.ts` (new)
- `packages/messaging/src/platform.ts` (remove old URN policy registry)
- `packages/messaging/src/index.ts` (re-exports)

### Phase 3: Discord Platform Registration

Convert Discord from side-effect registration to data export. Create the Discord platform registration object with config validator and URN validator.

- Create `platform-discord/src/platform-registration.ts` exporting `discordPlatformRegistration`
- Move URN policy from `register.ts` into the registration object
- Add `validateDiscordUrn` — validates resource type is `channel` or `dm`, validates snowflake format in leaf
- Add `validateDiscordConfig` — validates Discord-specific config properties (token, routes shape)
- Delete `register.ts` (the old side-effect registration)

**Files:**
- `packages/platform-discord/src/platform-registration.ts` (new)
- `packages/platform-discord/src/register.ts` (delete)
- `packages/platform-discord/src/messaging-urn-policy.ts` (refactor into registration)
- `packages/platform-discord/src/index.ts` (re-exports)

### Phase 4: Daemon Startup Wiring

Update daemon startup to use the new platform registry. Register platforms based on config.

- Import platform registration objects from configured platform packages
- Call `registerPlatform()` for each at startup
- Remove import of `registerBuiltInMessagingPlatforms`
- Update all call sites that used `getMessagingPlatformUrnPolicy` to use `getPlatformRegistration`

**Files:**
- `packages/daemon/src/index.ts`
- `packages/daemon/src/sessions/session-manager.ts` (if it references URN policies)
- Any file importing from the old registration API

### Phase 5: URN Migration

Update all URN construction sites to include resource type. Migrate existing session data in SQLite.

- Update all `formatAgentSessionUrn` / `mintAgentSessionUrn` call sites to pass resource type
- Update route parsing to include resource type in constructed URNs
- Update `defaultPrimarySessionUrnForAgent` call sites
- Add SQLite migration: update existing session URNs in `sessions` table to include resource type segment
- Update config route examples and documentation

**Files:**
- `packages/platform-discord/src/bridge.ts`
- `packages/platform-discord/src/adapter.ts`
- `packages/platform-discord/src/messaging-urn-policy.ts`
- `packages/daemon/src/sessions/session-manager.ts`
- `packages/daemon/src/sessions/session-router.ts`
- `packages/shared/src/session-urn.ts` (migration helper)
- `migrations/` (new migration for existing URNs)

### Phase 6: Callers & Tests

Update all remaining callers, fix tests, verify type-checking.

- Grep for old URN format patterns and update
- Update all test fixtures with new URN format
- Run `npx tsc --noEmit` across all packages
- Run test suites

**Files:**
- All test files referencing session URNs
- `packages/platform-discord/test/`
- `packages/daemon/test/`
- `packages/shared/test/` (if exists)

## Testing Strategy

- Unit test `parseAgentSessionUrn` with new format (resource type present, missing, invalid)
- Unit test backward compatibility: parser should reject old format URNs (no resource type) to catch missed migration sites
- Unit test platform registry: register, retrieve, validate config, validate URN
- Unit test Discord URN validator: valid channel/dm, invalid resource types, malformed snowflakes
- Unit test Discord config validator: valid config, missing token, malformed routes
- Integration test: daemon startup registers Discord, creates sessions with new URN format
- Migration test: existing URNs in SQLite are updated correctly

## Considerations

- **Breaking change** — Every existing session URN in the database becomes invalid. The migration in Phase 5 must update all stored URNs. A fresh state wipe is acceptable for this prototype, but the migration should exist for correctness.
- **Subagent URNs** — Subagent URNs currently append child UUIDs after the leaf: `agent:main:discord:1234:child-uuid`. With resource type: `agent:main:discord:channel:1234:child-uuid`. The parser needs to handle the shifted segment positions.
- **Log grep impact** — Anyone grepping logs for `agent:main:discord:` will still match, but specific session patterns change. Document the new format.
- **Config routes** — Route `sessionId` values in config files need updating to the new format. Document this in migration notes.
- **Default primary UUID** — `defaultPrimarySessionUrnForAgent` needs a resource type parameter. For Discord bootstrap, this is `channel`.
- **Future platforms** — The registry pattern means adding Slack/IRC/API is: implement `PlatformRegistration`, export it, daemon registers it. No core changes needed.

## Migration

- SQLite `sessions` table: update all `id` and `parent_session_id` columns to include resource type segment
- SQLite `transcript_messages` table: update `session_id` column
- SQLite `session_stats` table: update `session_id` column
- Config files: update route `sessionId` values to new format
- State wipe is acceptable as fallback for this prototype
