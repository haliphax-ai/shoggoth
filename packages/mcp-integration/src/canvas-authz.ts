/**
 * Authorization for openclaw-canvas-web / A2UI present and push paths.
 * Model: (principal, action, resource) where resource is the target session (or surface scoped to it).
 */

export type CanvasAuthzAction = "canvas.present" | "canvas.push" | "canvas.navigate";

export type CanvasPrincipalKind = "operator" | "agent" | "system";

export interface CanvasAuthzInput {
  readonly principalKind: CanvasPrincipalKind;
  /** Agent's own session when principalKind === "agent". */
  readonly agentSessionId?: string;
  readonly action: CanvasAuthzAction;
  /** Session id the canvas operation targets (e.g. push destination). */
  readonly resourceSessionId: string;
  /** Optional system component label for audit, e.g. `system:cron`. */
  readonly systemComponent?: string;
}

export type CanvasAuthzDecision = { allow: true } | { allow: false; reason: string };

export function authorizeCanvasAction(input: CanvasAuthzInput): CanvasAuthzDecision {
  if (!input.resourceSessionId) {
    return { allow: false, reason: "missing_resource_session" };
  }

  switch (input.principalKind) {
    case "operator":
      return { allow: true };
    case "system":
      if (!input.systemComponent?.trim()) {
        return { allow: false, reason: "system_principal_requires_component" };
      }
      return { allow: true };
    case "agent": {
      const sid = input.agentSessionId;
      if (!sid) {
        return { allow: false, reason: "agent_missing_session" };
      }
      if (sid !== input.resourceSessionId) {
        return { allow: false, reason: "agent_cannot_touch_foreign_session_canvas" };
      }
      return { allow: true };
    }
    default:
      return { allow: false, reason: "unknown_principal_kind" };
  }
}
