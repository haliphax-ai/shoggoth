export {
  loadAllPluginsFromConfig,
  resolveLocalPluginPath,
  resolveNpmPluginRoot,
  type LoadedPluginRef,
  type PluginAuditEvent,
  type PluginAuditOutcome,
} from "./load-plugins-from-config";
export { loadPluginFromDirectory, type LoadedPluginMeta } from "./plugin-loader";
export {
  parseShoggothPluginBag,
  resolvePluginMeta,
  shoggothPluginBagSchema,
  type ShoggothPluginBag,
  type ShoggothPluginMeta,
} from "./shoggoth-manifest";

// hooks-plugin based plugin system
export {
  createShoggothHooks,
  ShoggothPluginSystem,
  freezeConfig,
  type ShoggothHooks,
  type ShoggothHookName,
} from "./plugin-system";
export {
  defineMessagingPlatformPlugin,
  REQUIRED_MESSAGING_PLATFORM_HOOKS,
  type MessagingPlatformPlugin,
} from "./messaging-platform-plugin";
export {
  defineServicePlugin,
  REQUIRED_SERVICE_PLUGIN_HOOKS,
  type ServicePlugin,
} from "./service-plugin";
export {
  PlatformDeliveryRegistry,
  type PlatformDeliveryResolver,
  type OperatorDelivery,
} from "./platform-delivery-registry";

// Plugin fingerprinting
export { computePluginFingerprint, type PluginManifestForFingerprint } from "./plugin-fingerprint";

// Plugin registration gate (fingerprinting integration)
export {
  createGatedServiceRegisterCtx,
  buildManifestFromRegistration,
  type PluginApprovalStore,
  type GatedRegistrationResult,
  type RegistrationGateLogger,
  type CreateGatedContextOptions,
} from "./plugin-registration-gate";

// Plugin approval and ops enforcement
export {
  resolvePluginApprovalStatus,
  enforcePluginOps,
  createOpsEnforcementProxy,
  type PluginApprovalRecord,
  type PluginApprovalStatus,
  type PluginOpsDeclaration,
  type OpsEnforcementResult,
} from "./plugin-approval";

export type {
  DaemonConfigureCtx,
  DaemonStartupCtx,
  DaemonReadyCtx,
  DaemonShutdownCtx,
  PlatformRegisterCtx,
  PlatformDeps,
  PlatformStartCtx,
  PlatformStopCtx,
  MessageInboundCtx,
  MessageOutboundCtx,
  MessageReactionCtx,
  SessionTurnBeforeCtx,
  SessionTurnAfterCtx,
  SessionSegmentChangeCtx,
  HealthRegisterCtx,
  HealthProbe,
  HealthProbeResult,
  ServiceRegisterCtx,
  DirectServiceTool,
  DirectToolHandler,
  DirectToolContext,
  PluginServiceEntry,
} from "./hook-types";
