/** Short human-readable IDs for active subagent sessions. */
export const SHOGGOTH_SUBAGENT_AGENT_ID_MAX_LENGTH = 20;

/** Validate the intentionally narrower subagent slug syntax. */
export function assertValidSubagentAgentId(agentId: string): void {
  if (
    typeof agentId !== "string" ||
    agentId.length < 1 ||
    agentId.length > SHOGGOTH_SUBAGENT_AGENT_ID_MAX_LENGTH ||
    !/^[a-zA-Z0-9-]+$/.test(agentId)
  ) {
    throw new Error(
      `subagent agentId must be 1-${SHOGGOTH_SUBAGENT_AGENT_ID_MAX_LENGTH} alphanumeric or dash characters`,
    );
  }
}

/**
 * Convert a thread title into a unique subagent agent ID. The callback must include
 * active subagent IDs and configured top-level agent IDs so those IDs are reserved.
 */
export function deriveThreadSubagentAgentId(
  title: string,
  isUnavailable: (agentId: string) => boolean,
): string {
  const base =
    title
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, SHOGGOTH_SUBAGENT_AGENT_ID_MAX_LENGTH)
      .replace(/-+$/g, "") || "thread";
  if (!isUnavailable(base)) return base;

  for (let counter = 2; ; counter++) {
    const suffix = `-${counter}`;
    const prefix = base
      .slice(0, SHOGGOTH_SUBAGENT_AGENT_ID_MAX_LENGTH - suffix.length)
      .replace(/-+$/g, "");
    const candidate = `${prefix}${suffix}`;
    if (!isUnavailable(candidate)) return candidate;
  }
}
