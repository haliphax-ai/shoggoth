/**
 * Static control-op handler registry.
 *
 * `req.op` arrives as an arbitrary string from the wire; safety relies on
 * exact-string map lookups against literal keys and on `get()` returning
 * `undefined` for anything else. Never index, resolve, or interpolate `op`
 * into paths, imports, or command names. This module must stay a leaf
 * (imported by the policy engine) — no runtime state or config in its
 * import graph. Threat model and constraints: docs/daemon.md → Control Plane.
 */
import type { AuthenticatedPrincipal, WireRequest } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "./integration-ops";
import {
  handleAcpxBindGet,
  handleAcpxBindSet,
  handleAcpxBindDelete,
  handleAcpxBindList,
  handleAcpxAgentStart,
  handleAcpxAgentStop,
  handleAcpxAgentList,
} from "./acpx-ops";
import {
  handleSessionContextNew,
  handleSessionContextReset,
  handleSessionCompact,
} from "./session-context-ops";
import { handleMcpHttpCancelRequest } from "./mcp-ops";
import {
  handleHitlPendingList,
  handleHitlPendingGet,
  handleHitlPendingApprove,
  handleHitlPendingDeny,
  handleHitlClear,
  handleHitlCruiseControl,
} from "./hitl-ops";
import { handleSubagentSpawn, handleSubagentWait, handleSubagentResult } from "./subagent-ops";
import {
  handleSessionList,
  handleSessionContextStatus,
  handleSessionInspect,
  handleSessionSend,
  handleSessionSteer,
  handleSessionAbort,
  handleSessionKill,
  handleSessionModel,
  handleSessionQueueManage,
} from "./session-ops";
import { handlePrompt, handlePromptList } from "./prompt-ops-handler";
import { handleConfigShow, handleConfigRequest } from "./config-ops";
import { handleProcmanList, handleProcmanRestart, handleProcmanStop } from "./procman-ops";
import { handleElevationGrant, handleElevationRevoke, handleElevationList } from "./elevation-ops";
import { handleYoloMode } from "./yolo-ops";
import {
  handleVaultSet,
  handleVaultGet,
  handleVaultDelete,
  handleVaultList,
  handleVaultImport,
  handleVaultRotateKey,
} from "./vault-ops";
import {
  handleServiceList,
  handleServiceRequests,
  handleServiceRequest,
  handleServiceApprove,
  handleServiceRevoke,
  handleServiceRotateKey,
} from "./service-ops";
import { handleMediaGenerate, handleMediaGeneratePoll } from "./media-ops";
import { handleDecisionEvaluate, handleRerankDocuments } from "./decision-ops";

/**
 * A control-op handler as exported by the per-domain op modules.
 */
export type OpHandler = (
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
) => Promise<unknown>;

const OP_HANDLER_ENTRIES = [
  // acpx.ts
  ["acpx_bind_get", handleAcpxBindGet],
  ["acpx_bind_set", handleAcpxBindSet],
  ["acpx_bind_delete", handleAcpxBindDelete],
  ["acpx_bind_list", handleAcpxBindList],
  ["acpx_agent_start", handleAcpxAgentStart],
  ["acpx_agent_stop", handleAcpxAgentStop],
  ["acpx_agent_list", handleAcpxAgentList],
  // session-context-ops.ts
  ["session_context_new", handleSessionContextNew],
  ["session_context_reset", handleSessionContextReset],
  ["session_compact", handleSessionCompact],
  // hitl-ops.ts
  ["hitl_pending_list", handleHitlPendingList],
  ["hitl_pending_get", handleHitlPendingGet],
  ["hitl_pending_approve", handleHitlPendingApprove],
  ["hitl_pending_deny", handleHitlPendingDeny],
  ["hitl_clear", handleHitlClear],
  ["hitl_cruise_control", handleHitlCruiseControl],
  // mcp-ops.ts
  ["mcp_http_cancel_request", handleMcpHttpCancelRequest],
  // subagent-ops.ts
  ["subagent_spawn", handleSubagentSpawn],
  ["subagent_wait", handleSubagentWait],
  ["subagent_result", handleSubagentResult],
  // session-ops.ts
  ["session_list", handleSessionList],
  ["session_context_status", handleSessionContextStatus],
  ["session_inspect", handleSessionInspect],
  ["session_send", handleSessionSend],
  ["session_steer", handleSessionSteer],
  ["session_abort", handleSessionAbort],
  ["session_kill", handleSessionKill],
  ["session_model", handleSessionModel],
  ["session_queue_manage", handleSessionQueueManage],
  // prompt-ops-handler.ts
  ["prompt", handlePrompt],
  ["prompt_list", handlePromptList],
  // config-ops.ts
  ["config_show", handleConfigShow],
  ["config_request", handleConfigRequest],
  // procman-ops.ts
  ["procman_list", handleProcmanList],
  ["procman_restart", handleProcmanRestart],
  ["procman_stop", handleProcmanStop],
  // elevation-ops.ts
  ["elevation_grant", handleElevationGrant],
  ["elevation_revoke", handleElevationRevoke],
  ["elevation_list", handleElevationList],
  // yolo-ops.ts
  ["yolo_mode", handleYoloMode],
  // vault-ops.ts
  ["vault.set", handleVaultSet],
  ["vault.get", handleVaultGet],
  ["vault.delete", handleVaultDelete],
  ["vault.list", handleVaultList],
  ["vault.import", handleVaultImport],
  ["vault.rotate-key", handleVaultRotateKey],
  // service-ops.ts
  ["service.list", handleServiceList],
  ["service.requests", handleServiceRequests],
  ["service.request", handleServiceRequest],
  ["service.approve", handleServiceApprove],
  ["service.revoke", handleServiceRevoke],
  ["service.rotate-key", handleServiceRotateKey],
  // media-ops.ts
  ["media_generate", handleMediaGenerate],
  ["media_generate_poll", handleMediaGeneratePoll],
  // decision-ops.ts
  ["decision_evaluate", handleDecisionEvaluate],
  ["rerank_documents", handleRerankDocuments],
] as const;

type RegistryOp = (typeof OP_HANDLER_ENTRIES)[number][0];

/**
 * Every op dispatched through {@link OP_HANDLERS}, exported so the policy
 * engine's wire gate derives from the same registry. Adding an entry above
 * automatically makes the op defined for the wire layer and policy-visible;
 * no separate list to keep in sync.
 */
export type IntegrationControlOp = RegistryOp;

export const INTEGRATION_CONTROL_OPS: readonly IntegrationControlOp[] = OP_HANDLER_ENTRIES.map(
  ([op]) => op,
);

export const OP_HANDLERS: ReadonlyMap<string, OpHandler> = new Map<string, OpHandler>(
  OP_HANDLER_ENTRIES.map(([op, handler]) => [op, handler as OpHandler]),
);
