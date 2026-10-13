---
date: 2026-10-12
completed: 2026-10-13
---

# Guild-Scoped, Durable Discord Slash Commands

## Summary

Move Discord slash command registration from the application-global scope
(`PUT /applications/{id}/commands`) to per-guild scope
(`PUT /applications/{id}/guilds/{guildId}/commands`), and remove the
shutdown-time command teardown so command snowflake IDs stay stable across
restarts. This fixes command collisions and ID churn experienced when multiple
Shoggoth instances share one Discord application ID and bot token.

## Motivation

Discord application commands live in one of two scopes: global or guild.
Shoggoth currently registers its ten control slash commands **globally** at
startup and, on clean shutdown, bulk-overwrites the global list with `[]` to
avoid leaving stale commands behind. With a single instance this behavior is
merely aggressive; with multiple instances sharing the same application ID and
token it is broken:

- **Cross-instance teardown.** Any instance's shutdown wipes the _shared_
  global command list, deleting commands that other running instances (and
  their users) still depend on. The surviving instances never re-register
  until they restart.
- **Unstable command IDs.** Every restart cycle is delete-then-recreate:
  Discord assigns fresh snowflake IDs each time. Anything that cached a
  command ID (client-side, or integrations reading the command list) goes
  stale, and the operator has to "refresh the app" after every restart.
- **Global propagation delay.** Global command changes propagate slowly (up to
  an hour), so re-registration after a restart isn't even immediately visible.
- **Unnecessary blast radius.** A test instance and a production instance
  cannot coexist in the same guild: whichever starts last wins the global
  command list.

Guild-scoped registration removes all four problems: each instance owns only
its own guilds' command lists, guild command changes propagate instantly, and
because nothing deletes commands at shutdown anymore, IDs remain stable for
the life of the guild.

## Design

### Registration flow (startup)

`startDaemonDiscordMessaging` resolves the set of target guilds and calls a
reworked `registerDiscordSlashCommands`, which:

1. Bulk-overwrites each guild's command list
   (`PUT /applications/{id}/guilds/{guildId}/commands`) with the full Shoggoth
   command set. Discord matches existing commands **by name** during a bulk
   overwrite: same-name commands are updated in place (ID preserved), missing
   ones are created, unknown leftovers are pruned. This makes startup
   registration a convergent sync rather than a teardown.
2. Performs a one-time **legacy global cleanup**: fetches the application's
   global command list (`GET /applications/{id}/commands`) and deletes any
   command whose name matches a Shoggoth command
   (`DELETE /applications/{id}/commands/{commandId}`), so the previously
   registered global commands don't linger as duplicates alongside the new
   guild commands. Only _matched names_ are deleted — the old
   bulk-overwrite-with-`[]` approach would have destroyed unrelated global
   commands registered by other tooling under the same application.

### Guild set resolution

Target guilds are resolved in `bootstrap.ts`:

1. Explicit `platforms.discord.commandGuildIds` (new optional config array) —
   used when present.
2. Otherwise, the unique `guildId` values across the effective Discord routes
   (`resolveEffectiveDiscordRoutes`), which is where the bot already operates.

If neither yields any guild (DM-only deployment), registration is skipped
with a `discord.slash_commands.no_guilds` warning — guild-scoped commands
cannot exist without a guild, and re-introducing a global fallback would
recreate the exact collision problem this change removes.

### Shutdown flow

- `deregisterDiscordSlashCommands` is **deleted**. Nothing tears commands down
  at shutdown; the durable-ID requirement makes teardown actively harmful.
- `createDiscordMessagingShutdownDrain` is **deleted** — its only job was
  sequencing de-registration before transport stop. `plugin.ts` now registers
  a plain `discordMessaging.stop()` drain.
- The `slashCommandRegistrationRef` plumbing (plugin state field, bootstrap
  option) is removed; it only existed to make de-registration conditional on
  "this instance registered".

`registerSlashCommands: false` still disables registration entirely (kept).

### Transport additions

Three new methods on `DiscordRestTransport` (all background priority):

- `registerGuildCommands(applicationId, guildId, commands)` — bulk overwrite
- `listGlobalCommands(applicationId)` — read for legacy cleanup
- `deleteGlobalCommand(applicationId, commandId)` — legacy cleanup

`registerGlobalCommands` loses its last caller (registration now targets guilds; cleanup uses per-command DELETEs) and is removed, per the project's dead-code policy.

## Testing Strategy

Red/green TDD per the project's contribution rules. Test files:

- `packages/platform-discord/test/rest-transport.test.ts` — new transport
  methods hit the correct Discord REST paths with correct verbs.
- `packages/platform-discord/test/slash-commands.test.ts` — registration
  covers each guild exactly once; multiple guilds produce one bulk overwrite
  each; empty guild list performs no calls; legacy cleanup deletes only
  name-matched global commands and leaves foreign commands alone; drain
  behavior reduced to "stops messaging" (old de-registration assertions
  removed with the feature).

## Considerations

- **DM-only deployments lose slash commands.** Guild-only registration cannot
  serve DMs. This is accepted per the operator's directive; prefix prompts
  and the CLI remain available there.
- **Two instances bound to the same guild with different code versions** will
  alternate that guild's command list on startup (each bulk overwrite prunes
  the other's version). Same-name commands still keep their IDs; only
  definitions flap. Inherent to sharing one application; out of scope.
- **`cleanupLegacyGlobalCommands` runs on every startup.** After the first
  run it is a no-op GET returning an empty list; no need to persist a
  migration flag.
- Rate-limit cost: one bulk overwrite per guild plus one GET per startup —
  negligible at this scale.

## Migration

Automatic. On the first startup after upgrading:

1. Guild command lists are populated (new command IDs, one time).
2. Legacy global Shoggoth commands are deleted by name match.

No configuration change is required — guild IDs derive from existing routes.
Operators who want registration in guilds without routes can set
`platforms.discord.commandGuildIds` explicitly.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- Discord API: [Global Application Commands](https://discord.com/developers/docs/interactions/application-commands),
  [Guild Application Commands](https://discord.com/developers/docs/interactions/application-commands#get-guild-application-commands)

## Addendum (post-implementation, 2026-10-13)

- `registerGlobalCommands` removal moved from Phase 1 to the final cleanup
  phase: it kept its callers (registration + shutdown de-registration) until
  the registration rework landed, then was deleted alongside its last caller.
  Its stub entries in the `component-interactions`, `prompt-command`, and
  `status-bar-at-once` test transports were removed with it.
- The drain factory (`createDiscordMessagingShutdownDrain`) and the
  `slashCommandRegistrationRef` plumbing were removed in the wiring phase as
  planned; `plugin.ts` registers `registerDrain("discord-messaging", () => stop())`
  directly.
- The new config tests needed two things the plan didn't call out: the
  Discord platform registration must be active
  (`registerPlatform(discordPlatformRegistration)`) and route leaves must be
  snowflake- or UUID-shaped — `parseDiscordRoutesWithMeta` drops rows whose
  tail segments are neither, which silently emptied the derived guild set.
