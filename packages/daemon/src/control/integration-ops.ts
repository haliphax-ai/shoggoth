import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { getLogger } from "../logging";

const ioLog = getLogger("integration-ops");

/**
 * The OOB delivery stack (structured response delivery, subagent result
 * delivery, and the session store bound for out-of-context delivery guards)
 * is owned by `ops-shared.ts`; this module re-exports the binder for
 * `index.ts`.
 */
export { bindIntegrationOpsSessionStore } from "./ops-shared";
import type { AppendAuditRowInput } from "../audit/append-audit";
import type { AcpxProcessSupervisor } from "../acpx/acpx-process-supervisor";
import type { AcpxBindingStore } from "../acpx/sqlite-acpx-bindings";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import type { HitlConfigRef } from "../config-hot-reload";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import type { CruiseControlStore } from "../hitl/cruise-control";
import { OP_HANDLERS as opRegistry } from "./op-registry";

export class IntegrationOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationOpError";
  }
}

export type IntegrationAuditRecorder = (
  row: Pick<AppendAuditRowInput, "action" | "resource" | "outcome" | "argsRedactedJson">,
) => void;

export type IntegrationOpsContext = {
  readonly config: ShoggothConfig;
  /** SQLite handle for transcript deletes and other stateful integration ops. */
  readonly stateDb: Database.Database | undefined;
  readonly acpxStore: AcpxBindingStore | undefined;
  readonly sessions: SessionStore | undefined;
  readonly sessionManager: SessionManager | undefined;
  readonly acpxSupervisor: AcpxProcessSupervisor | undefined;
  readonly recordIntegrationAudit: IntegrationAuditRecorder;
  /** When unset, HITL control ops return ERR_HITL_UNAVAILABLE. */
  readonly hitlPending?: PendingActionsStore;
  /**
   * Cruise control (HITL auto-pilot) store. When unset, `hitl_cruise_control`
   * returns ERR_CRUISE_UNAVAILABLE.
   */
  readonly cruiseControl?: CruiseControlStore;
  /**
   * When set with {@link hitlPending}, `hitl_clear` can wipe agent/session auto-approve (disk + memory).
   * Omitted in minimal setups (e.g. tests with only the pending store).
   */
  readonly hitlClear?: {
    readonly configDirectory: string;
    readonly dynamicConfigDirectory?: string;
    readonly configRef: { current: ShoggothConfig };
    readonly hitlRef: HitlConfigRef;
    readonly autoApproveGate: HitlAutoApproveGate;
  };
  /** The vault service for credential management. */
  readonly vault?: import("../vault/vault-service").VaultService;
  /** The service approval store for managed services. */
  readonly serviceApprovalStore?: import("../service-approval-store").ServiceApprovalStore;
  /** The service registry for managed services. */
  readonly serviceRegistry?: import("../service-registry").ServiceRegistry;
  /** The service tool registry for managed services. */
  readonly serviceToolRegistry?: import("../service-tool-registry").ServiceToolRegistry;
  /** The service key store for age key management. */
  readonly serviceKeyStore?: import("../service-key-store").ServiceKeyStore;
  /**
   * Media generation service factory. Defaults to {@link MediaGenerationService.fromConfig}.
   * Override in tests to inject a fake instead of mocking the module.
   */
  readonly createMediaGenerationService?: (
    config: import("@shoggoth/shared").ShoggothMediaGenerationConfig,
  ) => import("../media/media-generation-service").MediaGenerationService;
  /**
   * Rerank service factory. Defaults to {@link RerankService.fromConfig}.
   * Override in tests to inject a fake instead of mocking the module.
   */
  readonly createRerankService?: (
    config: import("@shoggoth/shared").ShoggothRerankConfig,
  ) => import("../rerank/rerank-service").RerankService;
  readonly cancelMcpHttpRequest?: (input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly requestId: number;
  }) => boolean;
};

/**
 * Integration control-op router. `req.op` arrives as an arbitrary string from
 * the wire (parseRequestLine does not constrain its format); safety relies on
 * exact-string map lookups against literal keys, returning `undefined` for
 * anything else (callers then reject with ERR_UNKNOWN_OP). Never index,
 * resolve, or interpolate `op` into paths, imports, or command names.
 */
export function handleIntegrationControlOp(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind === "operator") {
    ioLog.info("operator action", {
      op: req.op,
      operatorId: principal.operatorId,
    });
  }
  const handler = opRegistry.get(req.op);
  if (handler === undefined) {
    // Preserve the switch's exact fall-through semantics: an unrecognized op
    // resolves to `undefined`, and the wire layer turns that into
    // ERR_UNKNOWN_OP (never index or interpolate req.op).
    return Promise.resolve(undefined);
  }
  return handler(req, principal, ctx);
}
