import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createFailoverClientFromModelsConfig,
  createFailoverToolCallingClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
} from "../src/from-config";
import type { ShoggothModelsConfig } from "@shoggoth/shared";

describe("createFailoverClientFromModelsConfig", () => {
  it("builds chain from config providers + failoverChain", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: [
        {
          id: "a",
          kind: "openai-compatible",
          baseUrl: "https://one.example/v1",
        },
        {
          id: "b",
          kind: "openai-compatible",
          baseUrl: "https://two.example/v1",
        },
      ],
      failoverChain: [
        { providerId: "a", model: "m1" },
        { providerId: "b", model: "m2" },
      ],
    };
    const c = createFailoverClientFromModelsConfig(cfg, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.usedProviderId, "a");
    assert.equal(r.usedModel, "m1");
  });

  it("throws when failover references unknown provider", () => {
    assert.throws(() =>
      createFailoverClientFromModelsConfig(
        {
          providers: [{ id: "a", kind: "openai-compatible", baseUrl: "https://x/v1" }],
          failoverChain: [{ providerId: "nope", model: "m" }],
        },
        {},
      ),
    );
  });

  it("builds failover chain with anthropic-messages provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: [
        {
          id: "anthropic-local",
          kind: "anthropic-messages",
          baseUrl: "http://127.0.0.1:8000",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          anthropicVersion: "2023-06-01",
        },
      ],
      failoverChain: [{ providerId: "anthropic-local", model: "claude-sonnet" }],
    };
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: { ANTHROPIC_API_KEY: "k" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "from-anthropic" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(r.usedProviderId, "anthropic-local");
    assert.equal(r.usedModel, "claude-sonnet");
    assert.equal(r.content, "from-anthropic");
  });

  it("uses bare apiKey for openai-compatible provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: [
        { id: "oai", kind: "openai-compatible", baseUrl: "https://x/v1", apiKey: "bare-key" },
      ],
      failoverChain: [{ providerId: "oai", model: "m" }],
    };
    let authHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: {},
      fetchImpl: async (_u, init) => {
        authHeader = (init?.headers as Record<string, string>)?.authorization ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(authHeader, "Bearer bare-key");
  });

  it("uses bare apiKey for anthropic-messages provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: [
        { id: "anth", kind: "anthropic-messages", baseUrl: "http://localhost:8000", apiKey: "bare-key" },
      ],
      failoverChain: [{ providerId: "anth", model: "m" }],
    };
    let apiKeyHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: {},
      fetchImpl: async (_u, init) => {
        apiKeyHeader = (init?.headers as Record<string, string>)?.["x-api-key"] ?? "";
        return new Response(
          JSON.stringify({ role: "assistant", content: [{ type: "text", text: "ok" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(apiKeyHeader, "bare-key");
  });

  it("bare apiKey takes precedence over apiKeyEnv", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: [
        { id: "oai", kind: "openai-compatible", baseUrl: "https://x/v1", apiKey: "bare", apiKeyEnv: "MY_KEY" },
      ],
      failoverChain: [{ providerId: "oai", model: "m" }],
    };
    let authHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: { MY_KEY: "from-env" },
      fetchImpl: async (_u, init) => {
        authHeader = (init?.headers as Record<string, string>)?.authorization ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(authHeader, "Bearer bare");
  });

  it("env fallback uses anthropic when ANTHROPIC_BASE_URL is set (no failoverChain)", async () => {
    let url = "";
    const c = createFailoverClientFromModelsConfig(undefined, {
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8000",
        ANTHROPIC_API_KEY: "k",
        SHOGGOTH_MODEL: "claude-sonnet-4-20250514",
      },
      fetchImpl: async (u) => {
        url = String(u);
        return new Response(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const r = await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.match(url, /\/v1\/messages$/);
    assert.equal(r.content, "hi");
    assert.equal(r.usedModel, "claude-sonnet-4-20250514");
    assert.equal(r.usedProviderId, "env-default");
  });

  it("env fallback tool client uses anthropic when ANTHROPIC_BASE_URL is set", async () => {
    let url = "";
    const c = createFailoverToolCallingClientFromModelsConfig(undefined, {
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8000",
        ANTHROPIC_API_KEY: "k",
        SHOGGOTH_MODEL: "m",
      },
      fetchImpl: async (u) => {
        url = String(u);
        return new Response(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const out = await c.completeWithTools({
      messages: [{ role: "user", content: "x" }],
      tools: [],
    });
    assert.match(url, /\/v1\/messages$/);
    assert.equal(out.content, "ok");
  });
});

describe("resolveCompactionPolicyFromModelsConfig", () => {
  it("applies defaults when compaction absent", () => {
    const p = resolveCompactionPolicyFromModelsConfig(undefined);
    assert.equal(p.maxContextChars > 0, true);
    assert.equal(p.preserveRecentMessages >= 0, true);
  });

  it("merges explicit compaction", () => {
    const p = resolveCompactionPolicyFromModelsConfig({
      compaction: { maxContextChars: 100, preserveRecentMessages: 2 },
    });
    assert.equal(p.maxContextChars, 100);
    assert.equal(p.preserveRecentMessages, 2);
  });
});
