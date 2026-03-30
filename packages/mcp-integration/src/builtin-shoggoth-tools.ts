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

const subagentSpawnOneShotArgs = {
  type: "object",
  description:
    "Spawn an internal one-shot subagent under this session; inherits model selection unless model_options is set.",
  properties: {
    prompt: { type: "string", description: "User task for the subagent" },
    model_options: {
      type: "object",
      description: "Optional overlay merged into inherited model_selection (JSON object)",
    },
  },
  required: ["prompt"],
} as const;

const subagentSpawnBoundArgs = {
  type: "object",
  description:
    "Spawn a thread-bound subagent (platform thread id, e.g. Discord); first reply uses messaging delivery.",
  properties: {
    thread_id: { type: "string", description: "Platform thread / forum channel snowflake" },
    prompt: { type: "string", description: "User task for the subagent" },
    model_options: { type: "object", description: "Optional model_selection overlay (JSON object)" },
    discord_user_id: { type: "string", description: "Optional delivery user id override" },
    reply_to_message_id: { type: "string", description: "Optional reply reference for first message" },
    lifetime_ms: { type: "integer", description: "Optional bound lifetime in ms" },
  },
  required: ["thread_id", "prompt"],
} as const;

const subagentInspectArgs = {
  type: "object",
  description: "No arguments; inspects this session row and direct child subagents",
  properties: {},
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
        name: "subagent.spawn_one_shot",
        description:
          "Run a one-shot child under this session (internal delivery). Top-level sessions only; subagents cannot call this.",
        inputSchema: subagentSpawnOneShotArgs,
      },
      {
        name: "subagent.spawn_bound",
        description:
          "Run a thread-bound child under this session (messaging surface delivery). Top-level sessions only.",
        inputSchema: subagentSpawnBoundArgs,
      },
      {
        name: "subagent.inspect",
        description: "Return this session metadata and list of child subagent sessions (same session only).",
        inputSchema: subagentInspectArgs,
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
          "Send a message to another session (session_id or agent_id for main session). silent skips posting the reply to the bound channel.",
        inputSchema: sessionSendArgs,
      },
    ],
  };
}
