#!/usr/bin/env -S npx tsx
/**
 * Dev tool: prints the dynamically-generated session system prompt to stdout
 * using realistic example values and an in-memory SQLite database for stats.
 *
 * Usage:  npx tsx scripts/preview-system-prompt.ts
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSessionSystemContext } from "@shoggoth/daemon/lib";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");
const TEMPLATES_DIR = resolvePath(__dirname, "..", "templates", "agent-workspace");
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";
import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";

// --- 1. In-memory SQLite with session_stats table + example data ---
// Prompts auto-load lazily from disk on first access inside buildSessionSystemContext.
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY);
  CREATE TABLE session_stats (
    session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    turn_count INTEGER NOT NULL DEFAULT 0,
    compaction_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    context_window_tokens INTEGER,
    first_turn_at TEXT,
    last_turn_at TEXT,
    last_compacted_at TEXT,
    transcript_message_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const SESSION_ID = "session:example:abc123";

db.prepare("INSERT INTO sessions (id) VALUES (?)").run(SESSION_ID);
db.prepare(`
  INSERT INTO session_stats (
    session_id, turn_count, compaction_count, input_tokens, output_tokens,
    context_window_tokens, first_turn_at, last_turn_at, last_compacted_at,
    transcript_message_count
  ) VALUES (
    @sessionId, @turnCount, @compactionCount, @inputTokens, @outputTokens,
    @contextWindowTokens, datetime('now', '-2 hours'), datetime('now'), datetime('now', '-30 minutes'),
    @transcriptMessageCount
  )
`).run({
  sessionId: SESSION_ID,
  turnCount: 45,
  compactionCount: 3,
  inputTokens: 15000,
  outputTokens: 8000,
  contextWindowTokens: 128000,
  transcriptMessageCount: 120,
});

// --- 3. Build a realistic ShoggothConfig ---
const config: ShoggothConfig = {
  ...defaultConfig("/etc/shoggoth/config.d"),
  models: {
    providers: [
      {
        id: "anthropic",
        kind: "anthropic-messages" as const,
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    ],
    failoverChain: [
      { providerId: "anthropic", model: "claude-sonnet-4-20250514" },
    ],
  },
  memory: {
    paths: ["/var/lib/shoggoth/memory"],
    embeddings: { enabled: false },
  },
};

// --- 4. Example messaging capabilities (Discord-like) ---
const messagingCapabilities: MessagingAdapterCapabilities = {
  platform: "discord",
  supports: { markdown: true, directMessages: true, groupChannels: true },
  extensions: {
    attachments: true,
    threads: true,
    replies: true,
    reactionsInbound: true,
    streamingOutbound: true,
    messageEdit: true,
    messageDelete: true,
    threadCreate: true,
    threadDelete: true,
    messageGet: true,
    react: true,
    reactions: true,
    search: true,
    attachmentDownload: true,
  },
  features: ["typing_notification", "silent_replies_channel_aware"],
  parameterSchemas: {
    outboundText: { type: "string", maxLength: 2000 },
    attachment: { type: "object" },
    threadReply: { type: "object" },
    streamChunk: { type: "string" },
  },
};

// --- 5. Example tool names ---
const toolNames = [
  "builtin-read",
  "builtin-write",
  "builtin-exec",
  "builtin-message",
  "builtin-subagent",
  "builtin-memory-search",
  "builtin-session-list",
  "builtin-session-send",
  "mcp-hass-get_state",
  "mcp-hass-call_service",
];

// --- 6. Build and print ---
const tmpWorkspace = mkdtempSync(join(tmpdir(), "shoggoth-preview-"));
try {
  // Copy default agent workspace templates into the temp directory
  cpSync(TEMPLATES_DIR, tmpWorkspace, { recursive: true });
  // Remove BOOTSTRAP.md
  rmSync(`${tmpWorkspace}/BOOTSTRAP.md`);

  const systemPrompt = buildSessionSystemContext({
    workspacePath: tmpWorkspace,
  config,
  env: {
    ...process.env,
    SHOGGOTH_MODEL: "anthropic/claude-sonnet-4-20250514",
  },
  sessionId: SESSION_ID,
  contextSegmentId: "seg-001",
  channel: "discord",
  messagingCapabilities,
  toolNames,
  sandbox: { runtimeUid: 1000, runtimeGid: 1000 },
  stateDb: db,
  transcriptMessages: [
    { role: "system", content: "You are a helpful assistant running inside Shoggoth." },
    { role: "user", content: "Hello, can you help me with a coding question about TypeScript generics?" },
    { role: "assistant", content: "Of course! TypeScript generics are a powerful feature that lets you write reusable, type-safe code. They allow you to create components that work with a variety of types rather than a single one. What specifically would you like to know?" },
    { role: "user", content: "How do I constrain a generic type parameter to only accept objects with a specific property?" },
    { role: "assistant", content: "You can use the `extends` keyword to constrain generic types. For example:\n\n```typescript\nfunction getProperty<T extends { name: string }>(obj: T): string {\n  return obj.name;\n}\n```\n\nThis ensures that `T` must have a `name` property of type `string`. You can also use interfaces:\n\n```typescript\ninterface HasId {\n  id: number;\n}\n\nfunction findById<T extends HasId>(items: T[], id: number): T | undefined {\n  return items.find(item => item.id === id);\n}\n```" },
    { role: "user", content: "That makes sense. Can I use multiple constraints?" },
    { role: "assistant", content: "Yes! You can intersect multiple constraints using `&`:\n\n```typescript\ninterface HasName { name: string; }\ninterface HasAge { age: number; }\n\nfunction greet<T extends HasName & HasAge>(person: T): string {\n  return `Hello ${person.name}, you are ${person.age} years old.`;\n}\n```\n\nYou can also use conditional types and mapped types for more advanced constraint patterns." },
    { role: "user", content: "What about constraining a generic to be one of several specific types?" },
  ],
});

  console.log(systemPrompt);
} finally {
  rmSync(tmpWorkspace, { recursive: true, force: true });
}

db.close();
