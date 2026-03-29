import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type Database from "better-sqlite3";
import { appendAuditRow } from "../audit/append-audit";
import type { ToolLoopAudit, ToolLoopPolicy } from "../sessions/tool-loop";
import { auditSourceForPrincipal, principalAuditFields } from "./audit-source";
import type { PolicyEngine } from "./engine";
import { redactJsonValue, redactToolArgsJson } from "./redact-json";

export type ToolLoopBridgeOptions = {
  readonly engine: PolicyEngine;
  readonly principal: AuthenticatedPrincipal;
  readonly db: Database.Database;
  /** Typically the tool run id or session correlation id. */
  readonly correlationId: string;
};

/**
 * Binds the central policy engine to the session tool loop and appends authz/tool audit rows.
 */
export function createToolLoopPolicyAndAudit(options: ToolLoopBridgeOptions): {
  policy: ToolLoopPolicy;
  audit: ToolLoopAudit;
} {
  const { engine, principal, db, correlationId } = options;
  const source = auditSourceForPrincipal(principal);
  const pf = principalAuditFields(principal);
  const paths = engine.config.auditRedaction.jsonPaths;

  const policy: ToolLoopPolicy = {
    check(ctx) {
      const decision = engine.check({
        principal,
        action: "tool.invoke",
        resource: ctx.toolName,
      });
      if (decision.allow) return { allow: true };
      return { allow: false, reason: decision.reason };
    },
  };

  const audit: ToolLoopAudit = {
    record(entry: unknown) {
      if (!entry || typeof entry !== "object") return;
      const e = entry as Record<string, unknown>;
      const phase = e.phase;
      if (phase === "policy") {
        const tool = String(e.tool ?? "");
        const decision = e.decision as { allow?: boolean; reason?: string } | undefined;
        const argsJson = typeof e.argsJson === "string" ? e.argsJson : undefined;
        const allow = Boolean(decision?.allow);
        appendAuditRow(db, {
          source,
          ...pf,
          correlationId,
          action: "authz.tool",
          resource: tool,
          outcome: allow ? "allowed" : "denied",
          argsRedactedJson:
            argsJson !== undefined
              ? redactToolArgsJson(argsJson, paths)
              : redactJsonValue(
                  { toolCallId: e.toolCallId, reason: decision?.reason },
                  paths,
                ),
        });
        return;
      }
      if (phase === "hitl_queued") {
        appendAuditRow(db, {
          source,
          ...pf,
          correlationId,
          action: "hitl.queued",
          resource: String(e.tool ?? ""),
          outcome: "pending",
          argsRedactedJson: redactJsonValue(
            {
              pendingId: e.pendingId,
              riskTier: e.riskTier,
              toolCallId: e.toolCallId,
            },
            paths,
          ),
        });
        return;
      }
      if (phase === "hitl_denied") {
        appendAuditRow(db, {
          source,
          ...pf,
          correlationId,
          action: "hitl.denied",
          resource: String(e.tool ?? ""),
          outcome: "denied",
          argsRedactedJson: redactJsonValue(
            {
              pendingId: e.pendingId,
              denialReason: e.denialReason,
              toolCallId: e.toolCallId,
            },
            paths,
          ),
        });
        return;
      }
      if (phase === "execute_start") {
        const argsJson = typeof e.argsJson === "string" ? e.argsJson : undefined;
        appendAuditRow(db, {
          source,
          ...pf,
          correlationId,
          action: "tool.invoke",
          resource: String(e.tool ?? ""),
          outcome: "started",
          argsRedactedJson: argsJson !== undefined ? redactToolArgsJson(argsJson, paths) : undefined,
        });
        return;
      }
      if (phase === "execute_done") {
        const resultJson =
          typeof e.resultJson === "string" ? (e.resultJson as string) : JSON.stringify(e.resultJson);
        appendAuditRow(db, {
          source,
          ...pf,
          correlationId,
          action: "tool.result",
          resource: String(e.tool ?? ""),
          outcome: "success",
          argsRedactedJson:
            resultJson.length > 4096
              ? JSON.stringify({ truncated: true, bytes: resultJson.length })
              : redactToolArgsJson(resultJson, paths),
        });
      }
    },
  };

  return { policy, audit };
}
