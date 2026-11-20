// Public API surface of @shoggoth/platform-discord: only modules consumed
// outside this package (see daemon tests). Internal src/ modules are NOT
// re-exported and may be refactored without notice.

export * from "./platform-registration";
export * from "./capabilities";
export * from "./probe";

// Discord plugin factory (MessagingPlatformPlugin entrypoint)
export { default as createDiscordPlugin } from "./plugin";
