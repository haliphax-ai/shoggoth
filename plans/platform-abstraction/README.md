# Platform Abstraction Refactor

## Goal

Remove Discord-specific coupling from core packages (`daemon`, `shared`, `messaging`, `mcp-integration`, `cli`). Discord-specific code should live in `platform-discord` only. Core code should use platform-agnostic abstractions.

## Scope

### 1. `packages/daemon/src/config/effective-runtime.ts` (biggest offender)

**Functions to rename/abstract:**
- `resolveDiscordRoutesJson` → `resolvePlatformRoutesJson` (or make it generic per-platform)
- `resolveEffectiveDiscordRoutesJson` → `resolveEffectivePlatformRoutesJson`
- `resolveDiscordIntents` → move to `platform-discord` (intents are Discord-specific)
- `resolveDiscordAllowBotMessages` → move to `platform-discord`
- `resolveDiscordOwnerUserId` → `resolvePlatformOwnerUserId` (owner concept is platform-agnostic)
- Default session platform hardcoded to `"discord"` → should have no default, or use a config-driven default

**Env vars referenced:**
- `SHOGGOTH_DISCORD_ROUTES` → `SHOGGOTH_PLATFORM_ROUTES` (or keep env vars as-is but abstract the function names — env vars are operator-facing config, renaming them is a separate concern)
- `SHOGGOTH_DISCORD_OWNER_USER_ID` → similar
- Various `SHOGGOTH_DISCORD_*` env vars for stream, model tag, HITL reply, etc.

**Strategy:** Functions that resolve Discord-specific config (intents, allowBotMessages, stream settings) should move to `platform-discord`. Functions that resolve platform-agnostic concepts (routes, owner) should be renamed to platform-agnostic names. The `resolvePlatformConfig(cfg, "discord")` calls are fine — they're already parameterized by platform name.

**Important:** Env var names are operator-facing. For now, keep the env var names as-is but add platform-agnostic aliases. The functions should check the platform-agnostic env var first, then fall back to the Discord-specific one for backward compat. Actually — haliphax said no backward compat needed (prototype). So just rename the env vars too.

### 2. `packages/daemon/src/health.ts`

- `createDiscordProbe` with hardcoded `https://discord.com/api/v10/users/@me` — this is inherently Discord-specific
- Move `createDiscordProbe` to `packages/platform-discord`
- Core health.ts should only have the generic probe interface and non-platform-specific probes

### 3. `packages/daemon/src/bootstrap-main-session.ts`

- Line 34: `const platform = config.runtime?.defaultSessionPlatform?.trim() || "discord";`
- Remove the `"discord"` fallback. If no default is configured, it should be undefined or error.

### 4. `packages/daemon/src/index.ts` and `packages/daemon/src/lib.ts`

- Remove direct imports of `createDiscordProbe`, `defaultDiscordAssistantDeps`, `DiscordPlatformAssistantDeps`
- These should come from `platform-discord` and be injected/registered, not imported directly in daemon core

### 5. `packages/daemon/src/control/resolve-session-cli-target.ts`

- References `SHOGGOTH_PRIMARY_DISCORD_CHANNEL_ID` and `resolveEffectiveDiscordRoutesJson`
- Rename to platform-agnostic: `SHOGGOTH_PRIMARY_CHANNEL_ID`
- Use the renamed platform-agnostic route resolution function

### 6. `packages/mcp-integration/src/message-tool-descriptor.ts`

- "Discord channel snowflake" → "platform channel identifier"
- "Discord GET /messages" → "platform message history"
- "delete_thread: thread channel snowflake (Discord)" → "delete_thread: thread/channel identifier"
- "Discord channel or thread snowflake" → "channel or thread identifier"
- "pivot snowflake" → "pivot message identifier"

### 7. `packages/mcp-integration/src/builtin-shoggoth-tools.ts`

- "snowflake" in thread_id description → "identifier"
- Line 115: `"spawn_persistent: optional platform thread / forum channel snowflake (omit for A2A-only)"` → `"spawn_persistent: optional platform thread / channel identifier (omit for A2A-only)"`

### 8. `packages/cli/src/run-subagent.ts`

- "snowflake" references in comments and heuristic
- The `/^\d+$/` heuristic for detecting thread IDs is Discord-specific (snowflakes are all digits). Make the comment platform-agnostic or note it's a heuristic that works for numeric platform IDs.

### 9. `packages/daemon/src/control/integration-ops.ts`

- Error messages: "start messaging platform; Discord when enabled" → "start messaging platform"
- "session_send requires messaging runtime (e.g. Discord platform started)" → "session_send requires messaging runtime"
- Line 93 comment about Discord platform → make generic

### 10. `packages/daemon/src/prompts/system-silent-replies-discord.md`

- Rename to `system-silent-replies-platform.md` or make content platform-agnostic
- Content: "Discord replies are always visible to the channel" → "Replies are always visible to the channel; there is no silent reply mechanism on this platform."

### 11. `packages/daemon/src/prompts/load-prompts.ts`

- Update reference from `"system-silent-replies-discord"` to the renamed prompt file

### 12. Comments (lower priority but do them)

- `packages/daemon/src/platforms/platform.ts` — extensive Discord references in JSDoc. Replace with generic language or "e.g. the Discord platform implementation"
- `packages/daemon/src/messaging/session-model-turn-delivery.ts` — Discord mention in comment
- `packages/daemon/src/mcp/mcp-http-cancel-registry.ts` — Discord mentions in comments
- `packages/daemon/src/notices/load-notices.ts` — Discord mention in comment
- `packages/shared/src/session-urn.ts` — snowflake mention in comments
- `packages/daemon/src/platforms/platform-command.ts` — Discord mention in comment

## Important Constraints

- Prototype project — no backward compat needed
- Do NOT install any packages
- When moving functions to `platform-discord`, make sure imports are updated everywhere
- Run `npm run typecheck` from repo root to verify compilation
- Run `npm test` from repo root to verify tests pass (917 tests, 0 failures expected)
- Exclude `node_modules/` from all searches
- Work methodically: rename/move functions first, then update all call sites, then update comments/docs/descriptions, then build and test
- If a function is used by both core and platform-discord, keep it in core with a platform-agnostic name
- The `resolvePlatformConfig(cfg, "discord")` pattern is already good — it's parameterized. Keep using it.
