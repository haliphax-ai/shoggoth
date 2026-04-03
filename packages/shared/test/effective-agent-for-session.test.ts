import assert from "node:assert";
import { describe, it } from "vitest";
import { formatAgentSessionUrn, SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID } from "../src/session-urn.js";
import {
  formatAgentIdentityPrefix,
  resolveEffectiveMemoryForSession,
  resolveEffectiveModelsConfig,
  SHOGGOTH_AGENT_DEFAULT_EMOJI,
} from "../src/effective-agent-for-session.js";
import type { ShoggothConfig } from "../src/schema.js";

describe("effective agent config for session", () => {
  const base: ShoggothConfig = {
    logLevel: "info",
    stateDbPath: "/tmp/s.db",
    socketPath: "/tmp/s.sock",
    workspacesRoot: "/w",
    secretsDirectory: "/s",
    inboundMediaRoot: "/m",
    operatorDirectory: "/o",
    configDirectory: "/c",
    hitl: {
      defaultApprovalTimeoutMs: 1,
      toolRisk: {},
      bypassUpTo: "safe",
    },
    memory: { paths: ["mem/global"], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: {
      operator: { controlOps: { allow: ["*"], deny: [] }, tools: { allow: ["*"], deny: [] } },
      agent: { controlOps: { allow: ["*"], deny: [] }, tools: { allow: ["*"], deny: [] } },
      auditRedaction: { jsonPaths: [] },
    },
    models: {
      failoverChain: [{ providerId: "p", model: "global-model" }],
      defaultInvocation: { temperature: 0.1 },
    },
  };

  const sid = formatAgentSessionUrn("alice", "discord", "channel", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);

  it("returns global models when no agents.list match", () => {
    const m = resolveEffectiveModelsConfig(base, sid);
    assert.equal(m?.failoverChain?.[0]?.model, "global-model");
  });

  it("merges per-agent failoverChain and defaultInvocation", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          alice: {
            models: {
              failoverChain: [{ providerId: "p", model: "alice-model" }],
              defaultInvocation: { temperature: 0.9 },
            },
          },
        },
      },
    };
    const m = resolveEffectiveModelsConfig(cfg, sid);
    assert.equal(m?.failoverChain?.[0]?.model, "alice-model");
    assert.equal(m?.defaultInvocation?.temperature, 0.9);
  });

  it("uses primary shorthand as single-hop chain", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: {
          alice: {
            models: {
              primary: { providerId: "q", model: "primary-only" },
            },
          },
        },
      },
    };
    const m = resolveEffectiveModelsConfig(cfg, sid);
    assert.equal(m?.failoverChain?.length, 1);
    assert.equal(m?.failoverChain?.[0]?.model, "primary-only");
    assert.equal(m?.failoverChain?.[0]?.providerId, "q");
  });

  it("formatAgentIdentityPrefix falls back to default emoji and agent id without agents.list entry", () => {
    assert.equal(
      formatAgentIdentityPrefix(base, sid),
      `**${SHOGGOTH_AGENT_DEFAULT_EMOJI} alice:**\n`,
    );
  });

  it("formatAgentIdentityPrefix uses agent id when displayName omitted", () => {
    const emptyEntry: ShoggothConfig = {
      ...base,
      agents: { list: { alice: {} } },
    };
    assert.equal(
      formatAgentIdentityPrefix(emptyEntry, sid),
      `**${SHOGGOTH_AGENT_DEFAULT_EMOJI} alice:**\n`,
    );
    const onlyEmoji: ShoggothConfig = {
      ...base,
      agents: { list: { alice: { emoji: "🤖" } } },
    };
    assert.equal(formatAgentIdentityPrefix(onlyEmoji, sid), "**🤖 alice:**\n");
  });

  it("formatAgentIdentityPrefix uses default emoji when only displayName is set", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: { list: { alice: { displayName: "A" } } },
    };
    assert.equal(
      formatAgentIdentityPrefix(cfg, sid),
      `**${SHOGGOTH_AGENT_DEFAULT_EMOJI} A:**\n`,
    );
  });

  it("formatAgentIdentityPrefix includes bold emoji and displayName", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: { list: { alice: { emoji: "🤖", displayName: "Rook" } } },
    };
    assert.equal(formatAgentIdentityPrefix(cfg, sid), "**🤖 Rook:**\n");
  });

  it("merges memory.paths for matching agent", () => {
    const cfg: ShoggothConfig = {
      ...base,
      agents: {
        list: { alice: { memory: { paths: ["extra/a"] } } },
      },
    };
    const mem = resolveEffectiveMemoryForSession(cfg, sid);
    assert.ok(mem.paths.includes("mem/global"));
    assert.ok(mem.paths.includes("extra/a"));
  });
});
