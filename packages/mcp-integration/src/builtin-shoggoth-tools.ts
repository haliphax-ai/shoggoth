import type { McpSourceCatalog } from "./aggregate";

/**
 * Example built-in tools as MCP descriptors for aggregation with external servers (plan: expose read/write/exec as MCP).
 */

const pathArg = {
  type: "object",
  description: "Workspace-relative path",
  properties: {
    path: { type: "string", description: "Path relative to session workspace" },
  },
  required: ["path"],
} as const;

const writeArgs = {
  type: "object",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
  },
  required: ["path", "content"],
} as const;

const execArgs = {
  type: "object",
  properties: {
    argv: {
      type: "array",
      items: { type: "string" },
      description: "Argv for exec; argv[0] is the binary",
    },
  },
  required: ["argv"],
} as const;

const memorySearchArgs = {
  type: "object",
  description: "Full-text search over ingested markdown memory (state DB FTS)",
  properties: {
    query: { type: "string", description: "Keywords or phrases to match" },
    limit: {
      type: "integer",
      description: "Max hits (1–25)",
      minimum: 1,
      maximum: 25,
    },
  },
  required: ["query"],
} as const;

const memoryIngestArgs = {
  type: "object",
  description: "No arguments",
  properties: {},
} as const;

const subagentToolArgs = {
  type: "object",
  description:
    "Subagent spawn, inspect, steer, abort, and kill. Allowed only when spawnSubagents is true (top-level and/or agents.list.<id>.spawnSubagents). Top-level sessions only for spawn; steer/kill target direct child subagents; abort may target own session or a direct child.",
  properties: {
    action: {
      type: "string",
      enum: ["spawn_one_shot", "spawn_bound", "inspect", "steer", "abort", "kill"],
      description:
        "spawn_one_shot / spawn_bound / inspect / steer / abort / kill — use fields below as required for each action.",
    },
    prompt: {
      type: "string",
      description: "spawn_one_shot, spawn_bound, steer: task or steer text",
    },
    thread_id: { type: "string", description: "spawn_bound: platform thread / forum channel snowflake" },
    model_options: {
      type: "object",
      description: "spawn_*: optional overlay merged into inherited model_selection",
    },
    discord_user_id: { type: "string", description: "spawn_bound, steer: optional messaging user id" },
    reply_to_message_id: { type: "string", description: "spawn_bound, steer: optional reply reference" },
    lifetime_ms: { type: "integer", description: "spawn_bound: optional bound lifetime in ms" },
    session_id: {
      type: "string",
      description:
        "steer, abort, kill: target session URN (child subagent for steer and kill; own session or child for abort)",
    },
    delivery: {
      type: "string",
      enum: ["internal", "post", "discord", "surface"],
      description:
        "steer: internal skips messaging surface; post, discord, or surface delivers via bound messaging",
    },
  },
  required: ["action"],
} as const;

const sessionListArgs = {
  type: "object",
  description:
    "List sessions from the daemon state DB. Agents only see sessions for their own agent id (from the calling session URN).",
  properties: {
    status: { type: "string", description: "Optional status filter (e.g. active, terminated)" },
    agent_id: {
      type: "string",
      description:
        "Optional agent id filter (operator only). Agents may omit or must match their own agent id.",
    },
  },
} as const;

const sessionSendArgs = {
  type: "object",
  description:
    "Deliver a user message to a session and run one model turn. Use session_id or agent_id (main session); not both. When silent is true, the assistant reply is not posted to the bound messaging surface (internal delivery only).",
  properties: {
    message: { type: "string", description: "User message content for the target session" },
    silent: {
      type: "boolean",
      description:
        "If true, do not post the assistant reply to the session bound channel; turn still runs internally",
    },
    session_id: { type: "string", description: "Target session URN (omit if agent_id is set)" },
    agent_id: { type: "string", description: "Logical agent id; targets that agent’s bootstrap main session" },
    discord_user_id: { type: "string", description: "When not silent, optional outbound user id for messaging_surface" },
    reply_to_message_id: { type: "string", description: "When not silent, optional reply reference" },
  },
  required: ["message"],
} as const;

export function builtinShoggothToolsCatalog(sourceId = "builtin"): McpSourceCatalog {
  return {
    sourceId,
    tools: [
      {
        name: "read",
        description: "Read a file under the session workspace",
        inputSchema: pathArg,
      },
      {
        name: "write",
        description: "Write a file under the session workspace",
        inputSchema: writeArgs,
      },
      {
        name: "exec",
        description: "Execute a command with cwd at workspace root",
        inputSchema: execArgs,
      },
      {
        name: "memory.search",
        description:
          "Search indexed markdown memory (BM25; optional vector rank when memory.embeddings.enabled and embeddings API succeeds). Configure memory.paths; call memory.ingest after adding or changing .md files under those roots.",
        inputSchema: memorySearchArgs,
      },
      {
        name: "memory.ingest",
        description:
          "Scan memory.paths (absolute or workspace-relative) for *.md and upsert into the daemon state DB for memory.search.",
        inputSchema: memoryIngestArgs,
      },
      {
        name: "subagent",
        description:
          "Unified subagent control: spawn (one_shot or bound thread), inspect this session’s children, steer/abort/kill child sessions (or abort own in-flight turn). Requires spawnSubagents in config when using agent token.",
        inputSchema: subagentToolArgs,
      },
      {
        name: "session.list",
        description:
          "List sessions (optional status and agent_id filters). Agents are scoped to their agent id automatically.",
        inputSchema: sessionListArgs,
      },
      {
        name: "session.send",
        description:
          "Send a message to another session (session_id or agent_id for main session). Cross-agent sends require agentToAgent.allow and/or agents.list.<senderId>.agentToAgent.allow in Shoggoth config (\"*\" allows any target). silent skips posting the reply to the bound channel.",
        inputSchema: sessionSendArgs,
      },
    ],
  };
}
