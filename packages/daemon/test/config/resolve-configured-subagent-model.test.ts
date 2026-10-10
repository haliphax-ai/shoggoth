import { describe, it } from "vitest";
import assert from "node:assert";
import { defaultConfig } from "@shoggoth/shared";
import { resolveConfiguredSubagentModel } from "../../src/config/effective-runtime";

const base = defaultConfig("/tmp/cfg");

describe("resolveConfiguredSubagentModel", () => {
  it("returns undefined when neither per-agent nor global subagentModel is set", () => {
    assert.equal(resolveConfiguredSubagentModel(base, "main"), undefined);
    assert.equal(resolveConfiguredSubagentModel(base, undefined), undefined);
  });

  it("uses the global agents.subagentModel when the agent has no override", () => {
    const cfg = { ...base, agents: { subagentModel: "provider-a/global-model" } };
    assert.equal(resolveConfiguredSubagentModel(cfg, "main"), "provider-a/global-model");
  });

  it("uses the global agents.subagentModel for an unknown agent id", () => {
    const cfg = { ...base, agents: { subagentModel: "provider-a/global-model" } };
    assert.equal(resolveConfiguredSubagentModel(cfg, "ghost"), "provider-a/global-model");
  });

  it("uses the global agents.subagentModel when agent id is undefined", () => {
    const cfg = { ...base, agents: { subagentModel: "provider-a/global-model" } };
    assert.equal(resolveConfiguredSubagentModel(cfg, undefined), "provider-a/global-model");
  });

  it("per-agent subagentModel overrides the global default", () => {
    const cfg = {
      ...base,
      agents: {
        subagentModel: "provider-a/global-model",
        list: { main: { subagentModel: "provider-b/agent-specific-model" } },
      },
    };
    assert.equal(resolveConfiguredSubagentModel(cfg, "main"), "provider-b/agent-specific-model");
  });

  it("falls back to global when the agent entry has no subagentModel override", () => {
    const cfg = {
      ...base,
      agents: {
        subagentModel: "provider-a/global-model",
        list: { main: { displayName: "Main" } },
      },
    };
    assert.equal(resolveConfiguredSubagentModel(cfg, "main"), "provider-a/global-model");
  });

  it("returns undefined when both are absent even with an agent list", () => {
    const cfg = { ...base, agents: { list: { main: { displayName: "Main" } } } };
    assert.equal(resolveConfiguredSubagentModel(cfg, "main"), undefined);
  });
});
