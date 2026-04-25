#!/usr/bin/env -S npx tsx
/**
 * Dev tool: prints the literal wire-format payload (system prompt, tools, and
 * messages) that would be sent to the model on the first user turn.
 *
 * Uses real internal methods — no mocked tool descriptors or hand-built
 * envelopes. External MCP tools are omitted (builtins only).
 *
 * Usage:  npx tsx scripts/preview-context.ts
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSessionSystemContext } from "@shoggoth/daemon/lib";
import { builtinShoggothToolsCatalog, aggregateMcpCatalogs } from "@shoggoth/mcp-integration";
import {
  defaultConfig,
  type ShoggothConfig,
  wrapWithSystemContext,
  generateSystemContextToken,
  type SystemContext,
} from "@shoggoth/shared";
import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");
const TEMPLATES_DIR = resolvePath(__dirname, "..", "templates", "agent-workspace");

// --- 1. In-memory SQLite with session_stats table + example data ---
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
db.prepare(
  `
  INSERT INTO session_stats (
    session_id, turn_count, compaction_count, input_tokens, output_tokens,
    context_window_tokens, first_turn_at, last_turn_at, last_compacted_at,
    transcript_message_count
  ) VALUES (
    @sessionId, @turnCount, @compactionCount, @inputTokens, @outputTokens,
    @contextWindowTokens, datetime('now', '-2 hours'), datetime('now'), datetime('now', '-30 minutes'),
    @transcriptMessageCount
  )
`,
).run({
  sessionId: SESSION_ID,
  turnCount: 45,
  compactionCount: 3,
  inputTokens: 15000,
  outputTokens: 8000,
  contextWindowTokens: 128000,
  transcriptMessageCount: 120,
});

// --- 2. Build a realistic ShoggothConfig ---
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
    failoverChain: [{ providerId: "anthropic", model: "claude-sonnet-4-20250514" }],
  },
  memory: {
    paths: ["/var/lib/shoggoth/memory"],
    embeddings: { enabled: false },
  },
};

// --- 3. Example messaging capabilities (Discord-like) ---
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

// --- 4. Tool descriptors from real builtin catalog ---
const aggregated = aggregateMcpCatalogs([builtinShoggothToolsCatalog()]);
const tools = aggregated.tools.map((t) => ({
  type: "function" as const,
  function: {
    name: t.namespacedName,
    description: t.description ?? `${t.sourceId}-${t.originalName}`,
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  },
}));

// --- 5. System context envelope (real wrapping) ---
const systemContextToken = generateSystemContextToken();

const exampleSystemContext: SystemContext = {
  kind: "inbound.message",
  summary: "User message from Discord #general channel",
  data: {
    sender: "exampleUser#1234",
    channel: "discord",
    chat_type: "channel",
    message_id: "1234567890",
  },
};

const rawUserContent = "Hello, can you help me with a coding question about TypeScript generics?";
const wrappedUserContent = wrapWithSystemContext(
  rawUserContent,
  exampleSystemContext,
  systemContextToken,
);

// --- 6. Transcript: system message + single wrapped user message ---
const transcriptMessages: Array<{ role: string; content: string }> = [
  {
    role: "system",
    content: "You are a helpful assistant running inside Shoggoth.",
  },
  { role: "user", content: wrappedUserContent },
];

// Tool names for the system prompt (derived from the real catalog)
const toolNames = aggregated.tools.map((t) => t.namespacedName);

// --- 7. Build and print full wire format ---
const tmpWorkspace = mkdtempSync(join(tmpdir(), "shoggoth-preview-"));
try {
  cpSync(TEMPLATES_DIR, tmpWorkspace, { recursive: true });
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
    transcriptMessages,
    systemContextToken,
    modelLabel: "claude-sonnet-4-20250514 (provider: anthropic)",
  });

  const wireFormat = {
    system: systemPrompt,
    tools,
    messages: transcriptMessages,
  };

  console.log(JSON.stringify(wireFormat, null, 2));
} finally {
  rmSync(tmpWorkspace, { recursive: true, force: true });
}

db.close();
