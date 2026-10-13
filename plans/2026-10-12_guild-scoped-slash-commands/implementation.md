# Implementation

Phased, red/green TDD. Each phase ends typechecking and its tests green, and
is committed separately. Run a phase's tests from the repo root:

```
npx vitest run packages/platform-discord/test/<file> --reporter=minimal
```

## Phase 1: Transport methods

Add the three guild/global-command methods to the transport interface and the
fetch-backed implementation. Red first: extend the stub transport in
`slash-commands.test.ts` and add path/verb assertions in
`rest-transport.test.ts`.

- `transport.ts` — add `registerGuildCommands`, `listGlobalCommands`,
  `deleteGlobalCommand`; remove `registerGlobalCommands`
- `rest-transport.ts` — implement all three (background priority lane);
  remove `registerGlobalCommands`
- `rest-transport.test.ts` — assert URL, method, auth header, JSON body for
  each new method
- `slash-commands.test.ts` — stub transport updated to satisfy the new
  interface (call-recording stubs)

**Files:**

- `packages/platform-discord/src/transport.ts`
- `packages/platform-discord/src/rest-transport.ts`
- `packages/platform-discord/test/rest-transport.test.ts`
- `packages/platform-discord/test/slash-commands.test.ts`

## Phase 2: Registration semantics

Rework `slash-commands.ts`: guild-scoped registration + legacy global
cleanup; delete `deregisterDiscordSlashCommands`. Rewrite the registration
and deregistration test blocks (deregistration tests are deleted with the
function; new tests cover per-guild bulk overwrite, multi-guild fan-out,
empty-guild no-op, and name-matched-only legacy deletion).

**Files:**

- `packages/platform-discord/src/slash-commands.ts`
- `packages/platform-discord/test/slash-commands.test.ts`

## Phase 3: Wiring and config

- `config.ts` — add `commandGuildIds` to the extension schema and
  `resolveDiscordCommandGuildIds`
- `bootstrap.ts` — resolve guild set, pass to registration, warn+skip on
  empty; remove `slashCommandRegistrationRef` option and
  `createDiscordMessagingShutdownDrain`
- `plugin.ts` — remove `slashCommandRegistrationRef` state field and both
  call sites; register a plain stop drain
- `config` resolution unit tests (new small describe block, e.g. in
  `test/discord-token-env.test.ts` style or a new `test/config.test.ts` if
  one doesn't exist)

**Files:**

- `packages/platform-discord/src/config.ts`
- `packages/platform-discord/src/bootstrap.ts`
- `packages/platform-discord/src/plugin.ts`
- `packages/platform-discord/test/config-command-guilds.test.ts` (new)

## Phase 4: Docs and verification

- `docs/platform-discord.md` — rewrite the Slash Commands section (guild
  scope, durable IDs, legacy cleanup, shutdown behavior) and the startup
  orchestration bullet; remove the stale "bulk overwrite clears all global
  commands" shutdown note
- Full package test run + repo typecheck; fix anything the removals broke
  elsewhere (e.g. knip/dead-code fallout)
- Mark the plan `completed` and move it to `plans/done/`

**Files:**

- `docs/platform-discord.md`
- `plans/2026-10-12_guild-scoped-slash-commands/README.md`
