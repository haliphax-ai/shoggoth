import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_POLICY_CONFIG, defaultConfig, type ShoggothConfig } from "@shoggoth/shared";
import { diffRestartRequiredKeys } from "../src/config-hot-reload";
import { createDelegatingPolicyEngine, createPolicyEngine, emptyPolicyConfig } from "../src/policy/engine";

function baseConfig(overrides: Partial<ShoggothConfig> = {}): ShoggothConfig {
  return { ...defaultConfig("/tmp/cfg"), ...overrides };
}

describe("config-hot-reload", () => {
  it("diffRestartRequiredKeys is empty when only policy changes", () => {
    const prev = baseConfig({ policy: DEFAULT_POLICY_CONFIG });
    const next = baseConfig({
      policy: {
        ...DEFAULT_POLICY_CONFIG,
        operator: {
          ...DEFAULT_POLICY_CONFIG.operator,
          tools: { allow: ["read"], deny: ["exec"] },
        },
      },
    });
    assert.deepStrictEqual(diffRestartRequiredKeys(prev, next), []);
  });

  it("diffRestartRequiredKeys reports socketPath change", () => {
    const prev = baseConfig({ socketPath: "/run/a.sock" });
    const next = baseConfig({ socketPath: "/run/b.sock" });
    assert.ok(diffRestartRequiredKeys(prev, next).includes("socketPath"));
  });

  it("createDelegatingPolicyEngine follows swapped engine", () => {
    const strict = createPolicyEngine({
      ...emptyPolicyConfig(),
      operator: {
        controlOps: { allow: ["ping"], deny: [] },
        tools: { allow: [], deny: [] },
      },
      agent: { controlOps: { allow: [], deny: [] }, tools: { allow: [], deny: [] } },
      auditRedaction: { jsonPaths: [] },
    });
    const ref = { engine: strict };
    const del = createDelegatingPolicyEngine(() => ref.engine);
    ref.engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
    const op: AuthenticatedPrincipal = {
      kind: "operator",
      operatorId: "x",
      roles: ["admin"],
      source: "cli_socket",
      peer: { uid: 1, gid: 1, pid: 1 },
    };
    const r = del.check({ principal: op, action: "control.invoke", resource: "version" });
    assert.strictEqual(r.allow, true);
  });
});
