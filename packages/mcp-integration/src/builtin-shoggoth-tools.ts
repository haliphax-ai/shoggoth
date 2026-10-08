import type { McpSourceCatalog } from "./aggregate";
import { buildWorkflowToolDescriptor } from "@shoggoth/workflow";
import {
  writeArgs,
  execArgs,
  memorySearchArgs,
  memoryIngestArgs,
  subagentToolArgs,
  sessionListArgs,
  sessionSendArgs,
  pollArgs,
  configRequestArgs,
  skillsToolArgs,
  sessionQueryArgs,
  showToolArgs,
  fsArgs,
  lsArgs,
  fetchArgs,
  kvArgs,
  timerArgs,
} from "./builtin-tool-schemas";

/**
 * Example built-in tools as MCP descriptors for aggregation with external servers (plan: expose read/write/exec as MCP).
 */

/** Canonical builtin source id. */
export const BUILTIN_SOURCE_ID = "builtin";

export function builtinShoggothToolsCatalog(sourceId = BUILTIN_SOURCE_ID): McpSourceCatalog {
  return {
    sourceId,
    tools: [
      {
        name: "read",
        description:
          "Read file content (text or image) from the workspace. Supports line ranges, multi-file globs, and stat-only mode.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Single file path (workspace-relative)" },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Multiple paths or glob patterns",
            },
            maxFiles: {
              type: "integer",
              description: "Cap on files returned for paths (default: 20)",
            },
            fromLine: { type: "integer", description: "First line to include, 1-indexed" },
            toLine: { type: "integer", description: "Last line to include, 1-indexed inclusive" },
            offset: { type: "integer", description: "Starting line, 1-indexed" },
            limit: { type: "integer", description: "Max lines to read" },
            stat: {
              type: "boolean",
              description:
                "Return metadata only (size, mtime, type, permissions, line count) — no content",
            },
            lines: {
              type: "boolean",
              description: "Split content by newlines and return as array",
            },
            lineNumbers: {
              type: "boolean",
              description: "Prefix each line with its line number (1-indexed)",
            },
          },
        },
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
          "Scan memory.paths (workspace-relative) for *.md and upsert into the daemon state DB for memory-search.",
        inputSchema: memoryIngestArgs,
      },
      {
        name: "subagent",
        description:
          "Unified subagent control: spawn (one_shot or persistent), inspect this session's children, steer/abort/kill child sessions (or abort own in-flight turn). Requires spawnSubagents in config when using agent token.",
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
          'Send a message to another session (session_id or agent_id for main session). Cross-agent sends require agentToAgent.allow and/or agents.list.<senderId>.agentToAgent.allow in Shoggoth config ("*" allows any target). silent skips posting the reply to the bound channel.',
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
          "Request a configuration change for a single top-level config key. The fragment (value for that key) is validated and written to the dynamic config directory as <key>.json. Use mode=merge (default) to deep-merge with existing values, or mode=overwrite to replace entirely.",
        inputSchema: configRequestArgs,
      },
      {
        name: "config-show",
        description: "Show the current daemon configuration (sensitive fields are redacted).",
        inputSchema: {
          type: "object" as const,
          properties: {
            dynamic: {
              type: "boolean",
              description:
                "When true, show only dynamic configuration fragments (written by config-request) instead of the full merged config.",
            },
          },
        },
      },
      {
        name: "show",
        description:
          "Display images or other content blocks to the user. Use this tool when you want to surface visual content (e.g. a generated chart, a screenshot, a fetched image). Provide at least one of path, url, or base64.",
        inputSchema: showToolArgs,
      },
      {
        name: "fs",
        description:
          "File operations: move, copy, delete, stat, chmod, mkdir. All paths are workspace-relative. Sandboxed to the workspace root.",
        inputSchema: fsArgs,
      },
      {
        name: "ls",
        description:
          "List directory contents under the session workspace. Returns entries with path, type, and optional size/mtime. Supports recursive listing, glob filtering, and hidden files.",
        inputSchema: lsArgs,
      },
      {
        name: "fetch",
        description:
          "Make an HTTP request. Returns status, headers, and body. Private/internal IPs are blocked by default. No redirect following by default. Response body capped at maxResponseBytes (default 1MB).",
        inputSchema: fetchArgs,
      },
      {
        name: "kv",
        description:
          "Lightweight key-value store scoped to the workspace. Backed by the state DB. Use for structured, machine-readable state (flags, counters, preferences). Keys max 256 chars, values max 64KB serialized.",
        inputSchema: kvArgs,
      },
      {
        name: "timer",
        description:
          "Schedule, cancel, or list deferred timer actions. Timers fire as user-turn messages at the specified time. Relative durations: Xs, Xm, Xh, Xd. Min 2 minutes, max 30 days. Per-session cap: 50 active timers. Optional anchor_session auto-cancels the timer when the anchored session terminates.",
        inputSchema: timerArgs,
      },
      {
        name: "discover",
        description:
          "Manage which tools are active. Call with enable/disable arrays of tool IDs, or list: true to see the full catalog.",
        inputSchema: {
          type: "object" as const,
          properties: {
            enable: {
              type: "array",
              items: { type: "string" },
              description: "Tool IDs to enable for this session.",
            },
            disable: {
              type: "array",
              items: { type: "string" },
              description: "Tool IDs to disable (collapse) for this session.",
            },
            list: {
              type: "boolean",
              description: "When true, list all available tools with their current state.",
            },
          },
        },
      },
      {
        name: "search",
        description:
          "Search for patterns in files using ripgrep. Returns structured results with file path, line number, context, and matched text.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File or directory path to search (workspace-relative)",
            },
            pattern: { type: "string", description: "Regex pattern to search for" },
            caseSensitive: {
              type: "boolean",
              description: "Case-sensitive search. Default: false (case-insensitive)",
            },
            contextLines: {
              type: "integer",
              description: "Lines of context around each match (default: 2)",
            },
            maxResults: {
              type: "integer",
              description: "Maximum number of matches to return (default: 100)",
            },
          },
          required: ["path", "pattern"],
        },
      },
      {
        name: "replace",
        description:
          "Replace patterns in files with support for regex replacements, line-level operations, and dry-run mode.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to the file to modify" },
            start: {
              type: "integer",
              description:
                "Start line number (1-indexed). Use with end for a single positional edit (delete if no replacement, replace if replacement provided). Mutually exclusive with pattern and edits.",
            },
            end: {
              type: "integer",
              description:
                "End line number (1-indexed, inclusive). Use with start for a single positional edit. Mutually exclusive with pattern and edits.",
            },
            replacement: {
              type: "string",
              description:
                "Replacement text. For regex mode: replacement for pattern matches (supports $1–$9). For positional edits: content to replace the line range with. Omit with start/end to delete lines.",
            },
            pattern: { type: "string", description: "Regex pattern to match" },
            caseSensitive: {
              type: "boolean",
              description: "Case-sensitive matching. Default: false",
            },
            maxOccurrences: {
              type: "integer",
              description: "Maximum number of replacements to make (default: unlimited)",
            },
            dryRun: {
              type: "boolean",
              description: "Preview changes without modifying file (default: false)",
            },
            multiline: {
              type: "boolean",
              description:
                "When true, regex patterns are treated as multiline (m flag). Enables \\\\n in patterns and makes ^/$ match line boundaries.",
            },
            fixedStrings: {
              type: "boolean",
              description:
                "When true, pattern is treated as a fixed/literal string instead of a regex. No regex escaping is performed — string matching is used directly. Use with multiline: true for multiline literal search-and-replace.",
            },
            edits: {
              type: "array",
              description:
                "Batch of positional edits applied to the ORIGINAL file state in a single call (max 50). Each edit references 1-indexed original line numbers; edits are applied bottom-up (highest line first) so earlier edits do not shift later line numbers. Mutually exclusive with pattern and start/end.",
              items: {
                type: "object",
                description:
                  "Positional edit: replace or delete a line range. Omit replacement to delete.",
                properties: {
                  start: {
                    type: "integer",
                    description: "1-indexed start line (inclusive)",
                  },
                  end: {
                    type: "integer",
                    description: "1-indexed end line (inclusive)",
                  },
                  replacement: {
                    type: "string",
                    description: "Replacement content. Omit to delete the range.",
                  },
                },
                required: ["start", "end"],
              },
            },
          },
          required: ["path"],
        },
      },
      {
        name: "cd",
        description:
          "Change the session working directory. Relative paths resolve against the current working directory. Empty path resets to workspace root. Path must stay within the workspace.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description:
                "Directory to change to. Absolute or relative to current working directory. Empty/omitted resets to workspace root.",
            },
          },
        },
      },
      buildWorkflowToolDescriptor(),
    ],
  };
}
