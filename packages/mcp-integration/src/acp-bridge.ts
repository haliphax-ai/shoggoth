/**
 * ACP / acpx: map external agent workspaces to Shoggoth sessions and principals.
 * The daemon may spawn `acpx` with these env vars so the agent can authenticate to the control plane.
 */

/** Unix socket path for Shoggoth control plane (JSONL wire). */
export const SHOGGOTH_CONTROL_SOCKET_ENV = "SHOGGOTH_CONTROL_SOCKET" as const;

/** Bound Shoggoth session id (matches `acpx_workspace_bindings.shoggoth_session_id`). */
export const SHOGGOTH_SESSION_ID_ENV = "SHOGGOTH_SESSION_ID" as const;

/** ACP workspace root (same as binding key); optional hint for agent tooling. */
export const SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV = "SHOGGOTH_ACPX_WORKSPACE_ROOT" as const;

export interface AcpxWorkspaceBinding {
  /** Root path acpx uses for the subagent workspace (normalized path recommended). */
  readonly acpWorkspaceRoot: string;
  readonly shoggothSessionId: string;
  readonly agentPrincipalId: string;
}

export function findBindingForAcpxWorkspace(
  bindings: readonly AcpxWorkspaceBinding[],
  acpWorkspaceRoot: string,
): AcpxWorkspaceBinding | undefined {
  return bindings.find((b) => b.acpWorkspaceRoot === acpWorkspaceRoot);
}

/** Mint a binding record (callers validate uniqueness). */
export function createAcpxBinding(input: AcpxWorkspaceBinding): AcpxWorkspaceBinding {
  return { ...input };
}
