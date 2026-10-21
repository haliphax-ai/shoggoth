import { describe, it, expect } from "vitest";
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
      providers: {
        a: {
          kind: "openai-compatible",
          baseUrl: "https://one.example/v1",
          models: {},
        },
        b: {
          kind: "openai-compatible",
          baseUrl: "https://two.example/v1",
          models: {},
        },
      },
      failoverChain: ["a/m1", "b/m2"],
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
          providers: { a: { kind: "openai-compatible", baseUrl: "https://x/v1", models: {} } },
          failoverChain: ["nope/m"],
        },
        {},
      ),
    );
  });

  it("builds failover chain with anthropic-messages provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: {
        "anthropic-local": {
          kind: "anthropic-messages",
          baseUrl: "http://127.0.0.1:8000",
          models: {},
          apiKeyEnv: "ANTHROPIC_API_KEY",
          anthropicVersion: "2023-06-01",
        },
      },
      failoverChain: ["anthropic-local/claude-sonnet"],
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
      providers: {
        oai: {
          kind: "openai-compatible",
          baseUrl: "https://x/v1",
          models: {},
          apiKey: "bare-key",
        },
      },
      failoverChain: ["oai/m"],
    };
    let authHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: {},
      fetchImpl: async (_u, init) => {
        authHeader = (init?.headers as Record<string, string>)?.authorization ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(authHeader, "Bearer bare-key");
  });

  it("uses bare apiKey for anthropic-messages provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: {
        anth: {
          kind: "anthropic-messages",
          baseUrl: "http://localhost:8000",
          models: {},
          apiKey: "bare-key",
        },
      },
      failoverChain: ["anth/m"],
    };
    let apiKeyHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: {},
      fetchImpl: async (_u, init) => {
        apiKeyHeader = (init?.headers as Record<string, string>)?.["x-api-key"] ?? "";
        return new Response(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    assert.equal(apiKeyHeader, "bare-key");
  });

  it("bare apiKey takes precedence over apiKeyEnv", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: {
        oai: {
          kind: "openai-compatible",
          baseUrl: "https://x/v1",
          models: {},
          apiKey: "bare",
          apiKeyEnv: "MY_KEY",
        },
      },
      failoverChain: ["oai/m"],
    };
    let authHeader = "";
    const c = createFailoverClientFromModelsConfig(cfg, {
      env: { MY_KEY: "from-env" },
      fetchImpl: async (_u, init) => {
        authHeader = (init?.headers as Record<string, string>)?.authorization ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
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

  it("throws when SHOGGOTH_MODEL is missing in env fallback (anthropic path)", () => {
    assert.throws(
      () =>
        createFailoverClientFromModelsConfig(undefined, {
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8000",
            ANTHROPIC_API_KEY: "k",
          },
          fetchImpl: async () => new Response(""),
        }),
      /SHOGGOTH_MODEL/,
    );
  });

  it("throws when SHOGGOTH_MODEL is missing in env fallback (gemini path)", () => {
    assert.throws(
      () =>
        createFailoverClientFromModelsConfig(undefined, {
          env: {
            GEMINI_API_KEY: "k",
          },
          fetchImpl: async () => new Response(""),
        }),
      /SHOGGOTH_MODEL/,
    );
  });

  it("throws when SHOGGOTH_MODEL is missing in env fallback (openai path)", () => {
    assert.throws(
      () =>
        createFailoverClientFromModelsConfig(undefined, {
          env: {
            OPENAI_API_KEY: "k",
          },
          fetchImpl: async () => new Response(""),
        }),
      /SHOGGOTH_MODEL/,
    );
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

describe("requestTimeoutMs resolution", () => {
  it("applies top-level models.requestTimeoutMs to every provider", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: {
        a: { kind: "openai-compatible", baseUrl: "https://a.example/v1", models: {} },
        b: { kind: "anthropic-messages", baseUrl: "https://b.example", models: {} },
      },
      failoverChain: ["a/m1", "b/m2"],
      requestTimeoutMs: 9_000,
    };
    const seen: (boolean | undefined)[] = [];
    const c = createFailoverClientFromModelsConfig(cfg, {
      fetchImpl: async (_u, init) => {
        seen.push((init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined);
        // First hop throws a network error so failover proceeds to the second.
        if (seen.length === 1) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(true);
    expect(seen[1]).toBe(true);
  });

  it("provider-level requestTimeoutMs overrides the top-level value", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: {
        a: {
          kind: "openai-compatible",
          baseUrl: "https://a.example/v1",
          models: {},
          requestTimeoutMs: 5_000,
        },
      },
      failoverChain: ["a/m1"],
      requestTimeoutMs: 9_000,
    };
    let dispatcherSeen = false;
    const c = createFailoverClientFromModelsConfig(cfg, {
      fetchImpl: async (_u, init) => {
        dispatcherSeen = (init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    expect(dispatcherSeen).toBe(true);
  });

  it("attaches no dispatcher when neither top-level nor provider timeout is set", async () => {
    const cfg: ShoggothModelsConfig = {
      providers: { a: { kind: "openai-compatible", baseUrl: "https://a.example/v1", models: {} } },
      failoverChain: ["a/m1"],
    };
    let dispatcherSeen = true;
    const c = createFailoverClientFromModelsConfig(cfg, {
      fetchImpl: async (_u, init) => {
        dispatcherSeen = (init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await c.complete({ messages: [{ role: "user", content: "x" }] });
    expect(dispatcherSeen).toBe(false);
  });
});

describe("resolveCompactionPolicyFromModelsConfig", () => {
  it("applies defaults when compaction absent", () => {
    const p = resolveCompactionPolicyFromModelsConfig(undefined);
    assert.equal(p.preserveRecentMessages >= 0, true);
  });

  it("merges explicit compaction", () => {
    const p = resolveCompactionPolicyFromModelsConfig({
      compaction: { preserveRecentMessages: 2 },
    });
    assert.equal(p.preserveRecentMessages, 2);
  });
});
