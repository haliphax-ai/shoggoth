// Public API surface of @shoggoth/platform-discord.
//
// This barrel is intentionally narrow: it re-exports only modules that are
// actually consumed outside this package (monorepo-wide consumption audit).
// Known external consumers of "@shoggoth/platform-discord", as of this audit:
//
//   - src/plugin.ts (this package's plugin entrypoint, imported via the
//     package name): startDaemonDiscordMessaging, startDiscordPlatform,
//     createDiscordInteractionHandler, handleDiscordHitlReactionAdd,
//     resolveDiscordOwnerUserId
//   - packages/daemon/test/control/resolve-session-cli-target.test.ts:
//     discordPlatformRegistration
//   - packages/daemon/test/sessions/session-system-prompt.test.ts:
//     discordCapabilityDescriptor
//   - packages/daemon/test/health.test.ts: createDiscordProbe
//
// Everything else under src/ (gateway-payload, transport, outbound, streaming,
// adapter, interaction, model-select, ...) is internal implementation detail.
// It is deliberately NOT re-exported here: import it via relative paths from
// within this package. It is not part of the stable API and may be refactored
// or removed without notice.

// Discord daemon integration (re-exported for src/plugin.ts)
export * from "./bootstrap";
export * from "./platform";
export * from "./slash-commands";
export * from "./hitl/reaction-handler";
export * from "./config";

// Platform integration points consumed by @shoggoth/daemon (tests)
export * from "./platform-registration";
export * from "./capabilities";
export * from "./probe";

// Discord plugin factory (MessagingPlatformPlugin entrypoint)
export { default as createDiscordPlugin } from "./plugin";
