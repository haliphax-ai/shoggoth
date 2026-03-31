import assert from "node:assert";
import { describe, it } from "node:test";
import { createHitlAutoApproveGate } from "../../src/hitl/hitl-auto-approve";
import {
  resolveCompoundResource,
  execSubResourceExtractor,
  type SubResourceExtractorRegistry,
} from "../../src/policy/sub-resource";

describe("HITL auto-approve with sub-resource extraction", () => {
  it("sticky approval for exec:curl does not auto-approve exec:rm", () => {
    const gate = createHitlAutoApproveGate();
    gate.enableSessionTool("s1", "exec:curl");
    assert.strictEqual(gate.shouldAutoApprove("s1", "exec:curl"), true);
    assert.strictEqual(gate.shouldAutoApprove("s1", "exec:rm"), false);
  });

  it("sticky approval for bare exec auto-approves all exec sub-resources", () => {
    const gate = createHitlAutoApproveGate();
    gate.enableSessionTool("s1", "exec");
    // bare "exec" only matches "exec" exactly in the current gate
    assert.strictEqual(gate.shouldAutoApprove("s1", "exec"), true);
  });
});

describe("resolveCompoundResource", () => {
  it("returns toolName:subResource when extractor returns a value", () => {
    const registry: SubResourceExtractorRegistry = new Map([
      ["exec", execSubResourceExtractor],
    ]);
    const result = resolveCompoundResource("exec", { command: "curl https://example.com" }, registry);
    assert.strictEqual(result, "exec:curl");
  });

  it("returns bare tool name when no extractor is registered", () => {
    const registry: SubResourceExtractorRegistry = new Map();
    const result = resolveCompoundResource("read", { path: "/etc/passwd" }, registry);
    assert.strictEqual(result, "read");
  });

  it("returns bare tool name when extractor returns undefined", () => {
    const registry: SubResourceExtractorRegistry = new Map([
      ["exec", () => undefined],
    ]);
    const result = resolveCompoundResource("exec", {}, registry);
    assert.strictEqual(result, "exec");
  });

  it("exec extractor produces compound resource for git command", () => {
    const registry: SubResourceExtractorRegistry = new Map([
      ["exec", execSubResourceExtractor],
    ]);
    const result = resolveCompoundResource("exec", { command: "git status" }, registry);
    assert.strictEqual(result, "exec:git");
  });

  it("exec extractor produces compound resource for absolute path command", () => {
    const registry: SubResourceExtractorRegistry = new Map([
      ["exec", execSubResourceExtractor],
    ]);
    const result = resolveCompoundResource("exec", { command: "/usr/bin/ls -la" }, registry);
    assert.strictEqual(result, "exec:ls");
  });
});
