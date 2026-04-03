import type { McpSourceCatalog } from "./aggregate";
import type { McpToolDescriptor } from "./mcp-tool";
import { buildWorkflowToolDescriptor } from "@shoggoth/workflow";

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
    path: { type: "string", description: "File path relative to session workspace" },
    content: { type: "string", description: "Content to write to the file" },
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
    timeout: {
      type: "integer",
      description: "Maximum milliseconds before the process is killed. Omit for no timeout.",
      minimum: 0,
    },
    stdin: {
      type: "string",
      description: "String to write to the process stdin before closing it.",
    },
    workdir: {
      type: "string",
      description: "Working directory for the command. Defaults to workspace root.",
    },
    env: {
      type: "object",
      additionalProperties: true,
      description: "Environment variable overrides (string values, merged with existing env).",
    },
    splitStreams: {
      type: "boolean",
      description: "When true, return stdout and stderr as separate fields instead of combined output.",
    },
    maxOutput: {
      type: "integer",
      description: "Maximum bytes of output to capture. Excess is truncated per the truncation strategy.",
      minimum: 0,
    },
    truncation: {
      type: "string",
      enum: ["head", "tail", "both"],
      description: "Truncation strategy when output exceeds maxOutput. Default: tail.",
    },
    background: {
      type: "boolean",
      description: "When true, start the process in the background immediately and return a session handle.",
    },
    yieldMs: {
      type: "integer",
      description:
        "Wait up to this many milliseconds for the process to finish. If still running, background it and return a handle. Mutually exclusive with background (background wins). 0 is equivalent to background: true.",
      minimum: 0,
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
    "Subagent spawn, inspect, steer, abort, kill, wait, and result. Allowed only when spawnSubagents is true (top-level and/or agents.list.<id>.spawnSubagents). Top-level sessions only for spawn; steer/kill target direct child subagents; abort may target own session or a direct child. wait blocks until one or more subagents complete; result retrieves the final output of a completed subagent.",
  properties: {
    action: {
      type: "string",
      enum: ["spawn_one_shot", "spawn_persistent", "inspect", "steer", "abort", "kill", "wait", "result"],
      description:
        "spawn_one_shot / spawn_persistent / inspect / steer / abort / kill / wait / result — use fields below as required for each action.",
    },
    prompt: {
      type: "string",
      description: "spawn_one_shot, spawn_persistent, steer: task or steer text",
    },
    thread_id: { type: "string", description: "spawn_persistent: optional platform thread / channel identifier (omit for A2A-only)" },
    model_options: {
      type: "object",
      description: "spawn_*: optional overlay merged into inherited model_selection",
    },
    platform_user_id: { type: "string", description: "spawn_persistent, steer: optional messaging user id" },
    reply_to_message_id: { type: "string", description: "spawn_persistent, steer: optional reply reference" },
    lifetime_ms: { type: "integer", description: "spawn_persistent: optional persistent lifetime in ms" },
    session_id: {
      type: "string",
      description:
        "steer, abort, kill, result: target session URN (child subagent for steer and kill; own session or child for abort; completed child for result)",
    },
    session_ids: {
      type: "array",
      items: { type: "string" },
      description: "wait: one or more subagent session IDs to wait on",
    },
    timeout_ms: {
      type: "integer",
      description: "wait: max wait time in ms before returning with timeout status (default 300000)",
    },
    mode: {
      type: "string",
      enum: ["all", "any"],
      description: "wait: 'all' waits for every ID, 'any' returns on first completion (default 'all')",
    },
    include_results: {
      type: "boolean",
      description: "wait: when true, embed each completed agent's final output in the response (default false)",
    },
    max_chars: {
      type: "integer",
      description: "result: truncate output to this many characters (default 8000). wait+include_results: per-agent limit (default 4000)",
    },
    respond_to: {
      type: "string",
      description: "spawn_one_shot, spawn_persistent: session ID where the subagent's completion result should be delivered (default: spawning session)",
    },
    internal: {
      type: "boolean",
      description: "spawn_one_shot, spawn_persistent: if true (default), deliver response as internal session message; if false, surface to the respondTo session's message platform binding",
    },
    delivery: {
      type: "string",
      enum: ["internal", "surface"],
      description:
        "steer: delivery mode. Defaults to internal for persistent subagents with no platform thread binding. For thread-bound persistent subagents, defaults to messaging_surface. Explicit internal skips messaging surface; other values deliver via the session's bound messaging platform",
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
    sort_by: {
      type: "string",
      enum: ["created", "lastActivity", "name"],
      description:
        "Field to sort results by. 'created' sorts by creation time, 'lastActivity' by last update, 'name' by session id. Default: 'created'.",
    },
    sort_order: {
      type: "string",
      enum: ["asc", "desc"],
      description: "Sort direction. Default: 'desc'.",
    },
    active_since: {
      type: "string",
      description:
        "ISO 8601 datetime. Only return sessions whose last activity is at or after this timestamp (inclusive lower bound).",
    },
    limit: {
      type: "integer",
      description: "Maximum number of sessions to return (applied after sort). Must be a positive integer.",
      minimum: 1,
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
    platform_user_id: { type: "string", description: "When not silent, optional outbound user id for messaging_surface" },
    reply_to_message_id: { type: "string", description: "When not silent, optional reply reference" },
  },
  required: ["message"],
} as const;

const pollArgs = {
  type: "object",
  description:
    "Check the status and output of a background process by PID. Returns current status, exit code (if finished), and captured output. Only tracks processes started via exec with background or yieldMs.",
  properties: {
    pid: {
      type: "integer",
      description: "Process ID of the background process to check",
    },
    timeout: {
      type: "integer",
      description:
        "Maximum milliseconds to wait for the process to finish before returning current status. 0 returns immediately (default).",
      minimum: 0,
    },
    streams: {
      type: "boolean",
      description:
        "When true, return stdout and stderr as separate fields instead of combined output",
    },
    tail: {
      type: "integer",
      description:
        "Return only the last N lines of output. Useful for long-running processes where only recent output matters.",
      minimum: 1,
    },
    since: {
      type: "integer",
      description:
        "Return only output captured after this byte offset. Enables incremental reads across multiple polls.",
      minimum: 0,
    },
  },
  required: ["pid"],
} as const;

const configRequestArgs = {
  type: "object",
  properties: {
    fragment: {
      type: "object",
      description: "Partial configuration fragment to merge",
    },
  },
  required: ["fragment"],
} as const;

const skillsToolArgs = {
  type: "object",
  description:
    "Query available skills: list all, resolve absolute path, or read content by id.",
  properties: {
    action: {
      type: "string",
      enum: ["list", "path", "read"],
      description:
        "list: return all skills as JSON array. path: return absolute filesystem path for a skill id. read: return path and file contents for a skill id.",
    },
    id: {
      type: "string",
      description: "Skill id (required for path and read actions)",
    },
  },
  required: ["action"],
} as const;

const sessionQueryArgs = {
  type: "object",
  description:
    "Read-only query of session transcript messages. Agents can only query sessions belonging to their own agent id unless explicitly allowed via sessionQuery config.",
  properties: {
    session_id: { type: "string", description: "Specific session URN to query (optional; without it, queries all allowed sessions)" },
    agent_id: { type: "string", description: "Filter by agent id (defaults to calling agent's own id; must be in allowed list)" },
    limit: { type: "integer", description: "Max messages to return (default 50, max 200)", minimum: 1, maximum: 200 },
    offset: { type: "integer", description: "Pagination offset (seq cursor; messages with seq > offset are returned)", minimum: 0 },
    role: {
      oneOf: [
        { type: "string", enum: ["user", "assistant", "system", "tool"] },
        { type: "array", items: { type: "string", enum: ["user", "assistant", "system", "tool"] } },
      ],
      description: "Filter to messages matching the given role(s). Accepts a single role string or an array. Empty array means no filter (all roles).",
    },
    query: { type: "string", description: "Case-insensitive substring search across message content. Only messages containing the query string are returned. Mutually exclusive with queryRegex." },
    queryRegex: { type: "string", description: "Regex pattern to match against message content. Mutually exclusive with query." },
    includeMetadata: { type: "boolean", description: "When true, each returned message includes _meta with timestamp (ISO 8601), tokenCount (approximate), and index (absolute position). Default false." },
    metadataOnly: { type: "boolean", description: "When true, return only role and _meta (no content). Implies includeMetadata. Useful for session size analysis without consuming context. Default false." },
    order: { type: "string", enum: ["asc", "desc"], description: "Traversal order by seq. 'desc' (default) returns newest first; 'asc' returns oldest first. When desc, offset defaults to the most recent message." },
  },
} as const;

/** Canonical builtin source id. */
export const BUILTIN_SOURCE_ID = "builtin";

export function builtinShoggothToolsCatalog(sourceId = BUILTIN_SOURCE_ID): McpSourceCatalog {
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
        name: "memory-search",
        description:
          "Search indexed markdown memory (BM25; optional vector rank when memory.embeddings.enabled and embeddings API succeeds). Configure memory.paths; call memory-ingest after adding or changing .md files under those roots.",
        inputSchema: memorySearchArgs,
      },
      {
        name: "memory-ingest",
        description:
          "Scan memory.paths (absolute or workspace-relative) for *.md and upsert into the daemon state DB for memory-search.",
        inputSchema: memoryIngestArgs,
      },
      {
        name: "subagent",
        description:
          "Unified subagent control: spawn (one_shot or persistent), inspect this session’s children, steer/abort/kill child sessions (or abort own in-flight turn). Requires spawnSubagents in config when using agent token.",
        inputSchema: subagentToolArgs,
      },
      {
        name: "session-list",
        description:
          "List sessions (optional status and agent_id filters). Agents are scoped to their agent id automatically.",
        inputSchema: sessionListArgs,
      },
      {
        name: "session-send",
        description:
          "Send a message to another session (session_id or agent_id for main session). Cross-agent sends require agentToAgent.allow and/or agents.list.<senderId>.agentToAgent.allow in Shoggoth config (\"*\" allows any target). silent skips posting the reply to the bound channel.",
        inputSchema: sessionSendArgs,
      },
      {
        name: "session-query",
        description:
          "Read-only query of session transcript messages. Returns messages with seq, role, and content. Agents can only query their own sessions unless allowed via sessionQuery config.",
        inputSchema: sessionQueryArgs,
      },
      {
        name: "poll",
        description:
          "Check the status and captured output of a background process by PID. Combines status check and output retrieval in a single call. Only tracks processes started via exec with background or yieldMs.",
        inputSchema: pollArgs,
      },
      {
        name: "skills",
        description:
          "Query available skills from the configured scan roots. Use list to enumerate, path to resolve a skill's file path, or read to get its content.",
        inputSchema: skillsToolArgs,
      },
      {
        name: "config-request",
        description:
          "Request a configuration change. The fragment is validated against the config schema and written to the daemon's dynamic config directory.",
        inputSchema: configRequestArgs,
      },
      {
        name: "config-show",
        description:
          "Show the current daemon configuration (sensitive fields are redacted).",
        inputSchema: { type: "object" as const, properties: {} },
      },
      buildWorkflowToolDescriptor() as McpToolDescriptor,
    ],
  };
}
