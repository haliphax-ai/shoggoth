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
    ],
  };
}
