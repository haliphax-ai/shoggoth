// Public API surface of @shoggoth/platform-discord.
//
// This barrel is intentionally narrow: it re-exports only modules that are
// actually consumed outside this package (monorepo-wide consumption audit).
// Known external consumers of "@shoggoth/platform-discord", as of this audit:
//
//   - packages/daemon/test/control/resolve-session-cli-target.test.ts:
//     discordPlatformRegistration
//   - packages/daemon/test/sessions/session-system-prompt.test.ts:
//     discordCapabilityDescriptor
//   - packages/daemon/test/health.test.ts: createDiscordProbe
//
// No file inside this package imports this barrel: src/plugin.ts and the tests
// under test/ import sibling modules via relative paths. Everything else under
// src/ (bootstrap, platform, slash-commands, hitl/reaction-handler, config,
// gateway-payload, transport, outbound, streaming, adapter, interaction,
// model-select, ...) is internal implementation detail. It is deliberately NOT
// re-exported here: import it via relative paths from within this package. It
// is not part of the stable API and may be refactored or removed without
// notice.

// Platform integration points consumed by @shoggoth/daemon (tests)
export * from "./platform-registration";
export * from "./capabilities";
export * from "./probe";

// Discord plugin factory (MessagingPlatformPlugin entrypoint)
export { default as createDiscordPlugin } from "./plugin";
