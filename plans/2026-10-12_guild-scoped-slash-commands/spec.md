# Specification

## Interfaces

### Transport (`packages/platform-discord/src/transport.ts`)

New methods on `DiscordRestTransport`; `registerGlobalCommands` removed.

```ts
/** PUT `/applications/{appId}/guilds/{guildId}/commands` — bulk-overwrite a guild's command list. */
registerGuildCommands(
  applicationId: string,
  guildId: string,
  commands: ReadonlyArray<Record<string, unknown>>,
): Promise<void>;
/** GET `/applications/{appId}/commands` — list the application's global commands. */
listGlobalCommands(
  applicationId: string,
): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>>;
/** DELETE `/applications/{appId}/commands/{commandId}` — remove one global command. */
deleteGlobalCommand(applicationId: string, commandId: string): Promise<void>;
```

### Config (`packages/platform-discord/src/config.ts`)

New optional field on the Discord extension schema:

```ts
const discordExtensionSchema = z.object({
  // ...existing fields...
  /** Explicit guild IDs to register slash commands in. Defaults to the unique
   *  guild IDs found across effective Discord routes. */
  commandGuildIds: z.array(z.string().min(1)).optional(),
});
```

### Bootstrap (`packages/platform-discord/src/bootstrap.ts`)

```ts
interface StartDaemonDiscordMessagingOptions {
  // ...existing fields...
  /** When true, register guild slash commands on startup (requires bot user id). */
  registerSlashCommands?: boolean;
  // REMOVED: slashCommandRegistrationRef
}

// REMOVED: createDiscordMessagingShutdownDrain
```

Guild-set resolution (new helper in `config.ts`):

```ts
/**
 * Resolve the guild IDs slash commands should be registered in: explicit
 * `platforms.discord.commandGuildIds` when present, otherwise the unique
 * guildId values across effective routes. Empty array when neither yields any.
 */
export function resolveDiscordCommandGuildIds(cfg: ShoggothConfig): string[];
```

### Slash commands (`packages/platform-discord/src/slash-commands.ts`)

```ts
/**
 * Register slash commands guild-by-guild via bulk overwrite (IDs of same-named
 * commands are preserved), then delete any legacy globally-registered
 * Shoggoth commands left by earlier versions.
 */
export async function registerDiscordSlashCommands(opts: {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
  readonly guildIds: readonly string[];
}): Promise<void>;

/**
 * One-time-migration helper: list global commands and DELETE only those whose
 * name matches a Shoggoth slash command. Foreign global commands untouched.
 */
export async function cleanupLegacyGlobalCommands(opts: {
  readonly transport: DiscordRestTransport;
  readonly applicationId: string;
}): Promise<void>;

// REMOVED: deregisterDiscordSlashCommands
```

## Behavior

### Startup registration sequence

```
startDaemonDiscordMessaging
  └─ registerSlashCommands !== false && discordBotUserId
       ├─ guildIds = resolveDiscordCommandGuildIds(config)
       │    ├─ non-empty → registerDiscordSlashCommands({transport, applicationId, guildIds})
       │    │    ├─ for each guildId: PUT /applications/{app}/guilds/{gid}/commands  [full set]
       │    │    └─ cleanupLegacyGlobalCommands
       │    │         ├─ GET /applications/{app}/commands
       │    │         └─ for each command whose name ∈ Shoggoth command names:
       │    │              DELETE /applications/{app}/commands/{command.id}
       │    └─ empty → logger.warn("discord.slash_commands.no_guilds"); skip
       └─ logger.info("discord.slash_commands.registered", {guildIds})
```

### Error handling

Registration failure is logged
(`discord.slash_commands.registration_failed`) and swallowed, matching
existing behavior — a REST hiccup at boot must not abort daemon startup.
Cleanup failures are likewise logged and swallowed; registration of guild
commands already succeeded at that point and remains in effect.

### Shutdown

`plugin.ts` registers `registerDrain("discord-messaging", () => stop())`
directly. No REST calls, no registration state.

## Config example

```jsonc
{
  "platforms": {
    "discord": {
      // optional; defaults to guild IDs derived from routes
      "commandGuildIds": ["1491824543705337988"],
    },
  },
}
```

## Log events

| Event                                                 | Level | Fields               |
| ----------------------------------------------------- | ----- | -------------------- |
| `discord.slash_commands.registered`                   | info  | `guildIds: string[]` |
| `discord.slash_commands.no_guilds`                    | warn  | —                    |
| `discord.slash_commands.registration_failed`          | warn  | `err`                |
| `discord.slash_commands.legacy_global_cleanup_failed` | warn  | `err`                |
