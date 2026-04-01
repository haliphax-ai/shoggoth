import {
  checkDiscordMessagingRouteSessionUrn,
  assertDiscordRoutesDefaultPrimaryUuidMatchesAgent,
  parseFirstDiscordChannelIdFromRoutesJson,
  resolveDiscordBootstrapPrimarySessionUrn,
} from "./messaging-urn-policy";
import { registerMessagingPlatformUrnPolicy, type MessagingPlatformUrnPolicy } from "@shoggoth/messaging";

const discordUrnPolicy: MessagingPlatformUrnPolicy = {
  platformId: "discord",
  checkRouteSessionUrn: checkDiscordMessagingRouteSessionUrn,
  assertRoutesDefaultPrimaryUuidMatchesAgent: assertDiscordRoutesDefaultPrimaryUuidMatchesAgent,
  parseFirstChannelIdFromRoutesJson: parseFirstDiscordChannelIdFromRoutesJson,
  resolveBootstrapPrimarySessionUrn: resolveDiscordBootstrapPrimarySessionUrn,
};

let didRegister = false;

/** Idempotent: registers built-in transport URN policies (Discord, …). Call once during daemon / CLI startup. */
export function registerBuiltInMessagingPlatforms(): void {
  if (didRegister) return;
  didRegister = true;
  registerMessagingPlatformUrnPolicy(discordUrnPolicy);
}
