import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import { WIRE_VERSION, type WireRequest } from "@shoggoth/authn";
import { appendAuditRow } from "../audit/append-audit";
import { auditSourceForPrincipal, principalAuditFields } from "../policy/audit-source";
import type { PolicyEngine } from "../policy/engine";
import type { Logger } from "../logging";
import {
  handleIntegrationControlOp,
  IntegrationOpError,
  type IntegrationOpsContext,
} from "./integration-ops";

export type AgentIntegrationInvoker = (
  sessionId: string,
  op: string,
  payload: unknown,
) => Promise<unknown>;

/**
 * In-process control ops as the given session’s agent (policy-checked). Used by built-in subagent tools
 * inside {@link executeSessionAgentTurn}; wire auth is skipped because the caller is already the daemon
 * running that session’s turn.
 */
export function createInProcessAgentIntegrationInvoker(input: {
  readonly integration: Pick<
    IntegrationOpsContext,
    | "config"
    | "stateDb"
    | "acpxStore"
    | "sessions"
    | "sessionManager"
    | "acpxSupervisor"
    | "hitlPending"
    | "cancelMcpHttpRequest"
  >;
  readonly policyEngine: PolicyEngine;
  readonly stateDb: Database.Database | undefined;
  readonly logger: Logger;
}): AgentIntegrationInvoker {
  return async (sessionId, op, payload) => {
    const principal: AuthenticatedPrincipal = { kind: "agent", sessionId, source: "agent" };
    const authz = input.policyEngine.check({
      principal,
      action: "control.invoke",
      resource: op,
    });
    if (!authz.allow) {
      throw new IntegrationOpError("ERR_FORBIDDEN", authz.reason);
    }
    const correlationId = randomUUID();
    const recordIntegrationAudit: IntegrationOpsContext["recordIntegrationAudit"] = (extras) => {
      if (!input.stateDb) return;
      try {
        const pf = principalAuditFields(principal);
        appendAuditRow(input.stateDb, {
          source: auditSourceForPrincipal(principal),
          ...pf,
          correlationId,
          action: extras.action,
          resource: extras.resource,
          outcome: extras.outcome,
          argsRedactedJson: extras.argsRedactedJson,
        });
      } catch (e) {
        input.logger.warn("agent integration audit append failed", { err: String(e) });
      }
    };
    const ctx: IntegrationOpsContext = {
      ...input.integration,
      recordIntegrationAudit,
    };
    const req: WireRequest = {
      v: WIRE_VERSION,
      id: correlationId,
      op,
      auth: { kind: "agent", session_id: sessionId, token: "" },
      payload,
    };
    return handleIntegrationControlOp(req, principal, ctx);
  };
}
