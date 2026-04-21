// Step 2: Discord-specific files from packages/messaging/src/discord/
export * from "./adapter";
export * from "./bot-user";
export * from "./bridge";
export * from "./gateway-client";
export * from "./gateway-payload";
export * from "./message-tool";
export * from "./messaging-urn-policy";
export * from "./rest-transport";
export * from "./transport";

// Step 3: Discord-specific code from packages/messaging/src/
export * from "./outbound";
export * from "./streaming";
export * from "./capabilities";
export * from "./platform-registration";

// Step 4: Discord-specific daemon code
export * from "./platform";
export * from "./errors";
export * from "./bootstrap";
export * from "./hitl/notifier";
export * from "./hitl/reaction-handler";
export * from "./hitl/reaction-wiring";
export * from "./hitl/notice-registry";
export * from "./interaction";
export * from "./slash-commands";

// Step 5: Discord config resolution
export * from "./config";

// Step 6: Discord health probe
export * from "./probe";

// Step 8: Discord plugin (MessagingPlatformPlugin)
export { createDiscordPlugin } from "./plugin";

// Step 7: Discord platform adapter (presentation layer integration)
export * from "./discord-platform-adapter";
