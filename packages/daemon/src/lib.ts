import { registerBuiltInMessagingPlatforms } from "@shoggoth/platform-discord";

registerBuiltInMessagingPlatforms();

export { openStateDb, getJournalMode } from "./db/open";
export { backupDatabaseToFile } from "./db/backup";
export {
  migrate,
  defaultMigrationsDir,
  assertMigrationsDirReadable,
} from "./db/migrate";
export {
  loadSessionTranscript,
  replaceSessionTranscript,
  compactSessionTranscript,
  type CompactSessionTranscriptOptions,
} from "./transcript-compact";
export { appendAuditRow, type AppendAuditRowInput } from "./audit/append-audit";
export {
  createPolicyEngine,
  createDelegatingPolicyEngine,
  emptyPolicyConfig,
  isDefinedControlOp,
  evaluateRules,
  DEFINED_CONTROL_OPS,
  type PolicyEngine,
  type PolicyAction,
  type PolicyCheckInput,
  type PolicyDecision,
} from "./policy/engine";
export {
  auditSourceForPrincipal,
  principalAuditFields,
  type AuditLogSource,
} from "./policy/audit-source";
export { redactToolArgsJson, redactJsonValue, redactDeep } from "@shoggoth/shared";
export { createToolLoopPolicyAndAudit, type ToolLoopBridgeOptions } from "./policy/tool-loop-bridge";
export {
  runRetentionJobs,
  retentionScheduleIntervalMs,
  retentionConfigHasRules,
} from "./retention/retention-jobs";
export type { RetentionRunSummary } from "./retention/retention-jobs";
export {
  runTranscriptAutoCompactTick,
  transcriptAutoCompactIntervalMs,
} from "./transcript-auto-compact";
export {
  parseMarkdownForMemory,
  buildFtsQuery,
  ingestMemoryRoots,
  searchMemoryFts,
  searchMemoryWithOptionalEmbedding,
  upsertMemoryEmbedding,
  type MemoryHit,
  type SearchMemoryHybridOptions,
} from "./memory/memory-index";
export {
  createSessionStore,
  getSessionContextSegmentId,
  type SessionStore,
  type SessionRow,
  type CreateSessionInput,
  type UpdateSessionInput,
  type SessionStatus,
} from "./sessions/session-store";
export { applySessionContextSegmentNew, applySessionContextSegmentReset } from "./sessions/session-context-segment";
export {
  parseSessionSegmentInlineCommand,
  sessionSegmentStartupUserContent,
} from "./sessions/session-segment-inline-command";
export {
  ensureAgentWorkspaceLayout,
  resolveAgentTemplateDir,
} from "./workspaces/agent-workspace-layout";
export {
  createTranscriptStore,
  type TranscriptStore,
  type TranscriptMessageRow,
  type AppendTranscriptInput,
} from "./sessions/transcript-store";
export { createToolRunStore, type ToolRunStore } from "./sessions/tool-run-store";
export {
  createSessionManager,
  SessionManagerError,
  type SessionManager,
  type SessionManagerOptions,
  type SpawnSessionInput,
  type SpawnSessionResult,
} from "./sessions/session-manager";
export { createSessionRouter, type SessionRouter } from "./sessions/session-router";
export {
  runToolLoop,
  type ToolCall,
  type ModelClient,
  type ToolExecutor,
  type ToolLoopPolicy,
  type ToolLoopAudit,
  type RunToolLoopOptions,
  type RunToolLoopHitl,
} from "./sessions/tool-loop";
export {
  buildAggregatedMcpCatalog,
  mcpToolsForToolLoop,
  createMcpRoutingToolExecutor,
  type BuiltinToolDelegate,
  type ExternalMcpInvoke,
} from "./mcp/tool-loop-mcp";
export {
  emitEvent,
  claimPendingEvents,
  markEventCompleted,
  markEventFailed,
  reconcileStaleProcessing,
  hasEventProcessingRecord,
  EVENT_SCOPE_GLOBAL,
  sessionEventScope,
  type EventQueueRow,
  type EventStatus,
  type EmitResult,
} from "./events/events-queue";
export { runCronTick, upsertCronJob, parseEverySchedule } from "./events/cron-scheduler";
export { runBootReconciliation, type BootReconciliationResult } from "./events/boot-reconciliation";
export {
  runHeartbeatBatch,
  createDefaultHeartbeatHandlers,
  type HeartbeatHandler,
  type HeartbeatBatchOptions,
} from "./events/heartbeat-consumer";
export { listDeadLetterEvents, type DeadLetterEventRow } from "./events/dlq";
export {
  createHitlPendingResolutionStack,
  type HitlPendingStack,
} from "./hitl/hitl-pending-stack";
export type { HitlNotifier } from "./hitl/hitl-notifier";
export { createHitlResolutionHub, type HitlResolutionHub } from "./hitl/hitl-resolution-hub";
export {
  createPendingActionsStore,
  type PendingActionsStore,
  type PendingActionRow,
  type PendingActionStatus,
} from "./hitl/pending-actions-store";
export { invokeControlRequest, type InvokeControlRequestInput } from "./control/control-client";
export { SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS } from "./subagent/subagent-constants";
export { resolveSessionTargetFromCliArg } from "./control/resolve-session-cli-target";
export { createLogger, type Logger, type LogLevel, type LogFields } from "./logging";
export { createHitlAutoApproveGate, type HitlAutoApproveGate } from "./hitl/hitl-auto-approve";
export { transcriptRowsToModelChatMessages } from "./sessions/transcript-to-chat";
export { daemonNotice, loadDaemonNotices } from "./notices/load-notices";
export {
  resolveBootstrapPrimarySessionUrn,
  parseFirstChannelIdFromRoutesJson,
} from "@shoggoth/messaging";

// --- Exports needed by @shoggoth/platform-discord ---
export {
  executeSessionAgentTurn,
  type ExecuteSessionAgentTurnInput,
  type SessionAgentTurnResult,
} from "./sessions/session-agent-turn";
export { TieredTurnQueue, TurnDroppedError, TurnQueueFullError, type TurnPriority, type QueueDepth, type QueueEntryInfo } from "./sessions/session-turn-queue";
export { getTurnQueue, setTurnQueue } from "./sessions/session-turn-queue-singleton";
export {
  runInboundSessionTurn,
  createCoalescingStreamPusher,
  type InboundSessionTurnStreaming,
  type InboundSessionTurnInput,
  type RunInboundSessionTurnOptions,
} from "./messaging/inbound-session-turn";
export {
  buildSessionSystemContext,
  type BuildSessionSystemContextInput,
} from "./sessions/session-system-prompt";
export {
  createSessionMcpRuntime,
  registerContextFinalizer,
  type SessionMcpRuntime,
  type CreateSessionMcpRuntimeOptions,
  type SessionMcpContextFinalizer,
} from "./sessions/session-mcp-runtime";
export type {
  SessionToolLoopFailoverState,
  SessionToolLoopModelClient,
} from "./sessions/session-tool-loop-model-client";
export {
  resolveSessionBypassUpTo,
} from "./hitl/session-agent-principals";
export type { SessionModelTurnDelivery } from "./messaging/session-model-turn-delivery";
export type { HitlConfigRef } from "./config-hot-reload";
export {
  defaultPlatformAssistantDeps,
  type PlatformAssistantDeps,
} from "./sessions/assistant-runtime";
export {
  connectShoggothMcpServers,
  partitionMcpServersByEffectiveScope,
  type ConnectShoggothMcpPoolOptions,
  type McpServerPool,
} from "./mcp/mcp-server-pool";
export {
  parsePlatformCommand,
  translateCommandToControlOp,
  type PlatformCommand,
  type ControlOpRequest,
} from "./platforms/platform-command";

// --- Presentation layer exports (used by platform-discord) ---
export {
  formatDegradedPrefix,
  formatModelTagFooter,
  formatErrorUserText,
  formatAssistantReply,
  type FailoverMeta,
} from "./presentation/reply-formatter";
export {
  formatHitlPayloadExcerpt,
  buildHitlQueuedNoticeLines,
  HITL_NOTICE_PAYLOAD_MAX_CHARS,
  type HitlPendingActionRow,
} from "./presentation/hitl-notice-formatter";
export {
  routeReaction,
  parseReactionLegend,
  type ReactionRouteInput,
  type ReactionRouteResult,
  type ReactionLegendEntry,
  type ParsedReactionLegend,
} from "./presentation/reaction-router";
export {
  buildMinimalContextMessages,
  formatGlobalReactionEventContext,
  formatAdhocReactionEventContext,
  type MinimalContextInput,
} from "./presentation/minimal-context";
