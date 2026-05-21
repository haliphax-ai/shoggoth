import assert from "node:assert";
import { describe, test } from "vitest";

// These imports target source that DOES NOT EXIST yet — tests must fail (RED phase).
import {
  computePluginFingerprint,
  type PluginManifestForFingerprint,
} from "../src/plugin-fingerprint";
import {
  resolvePluginApprovalStatus,
  enforcePluginOps,
  type PluginApprovalRecord,
  type PluginOpsDeclaration,
} from "../src/plugin-approval";

// ---------------------------------------------------------------------------
// 1. computePluginFingerprint — deterministic
// ---------------------------------------------------------------------------
describe("computePluginFingerprint", () => {
  const baseManifest: PluginManifestForFingerprint = {
    name: "test-plugin",
    version: "1.0.0",
    tools: [
      { name: "tool-a", description: "Does A", parameters: { type: "object" } },
      { name: "tool-b", description: "Does B", parameters: { type: "object" } },
    ],
    ops: ["fs.read", "fs.write", "net.fetch"],
  };

  test("is deterministic — same input produces same output", () => {
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(baseManifest);
    assert.strictEqual(hash1, hash2, "fingerprint should be identical for same input");
    assert.ok(
      typeof hash1 === "string" && hash1.length > 0,
      "fingerprint should be a non-empty string",
    );
  });

  test("is deterministic regardless of tool/ops ordering", () => {
    const reordered: PluginManifestForFingerprint = {
      ...baseManifest,
      tools: [...baseManifest.tools].reverse(),
      ops: [...baseManifest.ops].reverse(),
    };
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(reordered);
    assert.strictEqual(hash1, hash2, "fingerprint should be order-independent");
  });

  // -------------------------------------------------------------------------
  // 2. fingerprint changes when tools change
  // -------------------------------------------------------------------------
  test("changes when tools change", () => {
    const modified: PluginManifestForFingerprint = {
      ...baseManifest,
      tools: [
        ...baseManifest.tools,
        { name: "tool-c", description: "Does C", parameters: { type: "object" } },
      ],
    };
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(modified);
    assert.notStrictEqual(hash1, hash2, "fingerprint should differ when tools are added");
  });

  test("changes when a tool's parameters change", () => {
    const modified: PluginManifestForFingerprint = {
      ...baseManifest,
      tools: [
        {
          name: "tool-a",
          description: "Does A",
          parameters: { type: "object", properties: { x: { type: "number" } } },
        },
        baseManifest.tools[1],
      ],
    };
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(modified);
    assert.notStrictEqual(hash1, hash2, "fingerprint should differ when tool parameters change");
  });

  // -------------------------------------------------------------------------
  // 3. fingerprint changes when ops change
  // -------------------------------------------------------------------------
  test("changes when ops change", () => {
    const modified: PluginManifestForFingerprint = {
      ...baseManifest,
      ops: ["fs.read", "fs.write", "net.fetch", "exec.spawn"],
    };
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(modified);
    assert.notStrictEqual(hash1, hash2, "fingerprint should differ when ops are added");
  });

  test("changes when an op is removed", () => {
    const modified: PluginManifestForFingerprint = {
      ...baseManifest,
      ops: ["fs.read"],
    };
    const hash1 = computePluginFingerprint(baseManifest);
    const hash2 = computePluginFingerprint(modified);
    assert.notStrictEqual(hash1, hash2, "fingerprint should differ when ops are removed");
  });
});

// ---------------------------------------------------------------------------
// 4–6. Plugin approval status resolution
// ---------------------------------------------------------------------------
describe("resolvePluginApprovalStatus", () => {
  const manifest: PluginManifestForFingerprint = {
    name: "my-service-plugin",
    version: "2.0.0",
    tools: [{ name: "svc.call", description: "Call service", parameters: {} }],
    ops: ["net.fetch", "db.query"],
  };

  // -------------------------------------------------------------------------
  // 4. No approval record → 'pending'
  // -------------------------------------------------------------------------
  test("plugin with no approval record enters 'pending' status", () => {
    const status = resolvePluginApprovalStatus(manifest, undefined);
    assert.strictEqual(status.state, "pending");
    assert.ok(status.fingerprint, "should include the computed fingerprint");
  });

  // -------------------------------------------------------------------------
  // 5. Matching fingerprint → stays 'approved'
  // -------------------------------------------------------------------------
  test("plugin with matching fingerprint stays 'approved'", () => {
    const fingerprint = computePluginFingerprint(manifest);
    const record: PluginApprovalRecord = {
      pluginName: manifest.name,
      fingerprint,
      approvedAt: new Date().toISOString(),
      approvedOps: manifest.ops,
    };
    const status = resolvePluginApprovalStatus(manifest, record);
    assert.strictEqual(status.state, "approved");
  });

  // -------------------------------------------------------------------------
  // 6. Changed fingerprint → 'pending-reapproval'
  // -------------------------------------------------------------------------
  test("plugin with changed fingerprint enters 'pending-reapproval'", () => {
    const oldRecord: PluginApprovalRecord = {
      pluginName: manifest.name,
      fingerprint: "old-stale-fingerprint-abc123",
      approvedAt: new Date().toISOString(),
      approvedOps: ["net.fetch"],
    };
    const status = resolvePluginApprovalStatus(manifest, oldRecord);
    assert.strictEqual(status.state, "pending-reapproval");
    assert.ok(status.fingerprint, "should include the new fingerprint");
    assert.notStrictEqual(status.fingerprint, oldRecord.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// 7–8. Plugin ops enforcement
// ---------------------------------------------------------------------------
describe("enforcePluginOps", () => {
  const declaration: PluginOpsDeclaration = {
    pluginName: "my-service-plugin",
    allowedOps: ["net.fetch", "db.query", "fs.read"],
  };

  // -------------------------------------------------------------------------
  // 7. Allowed op succeeds
  // -------------------------------------------------------------------------
  test("allowed op succeeds", () => {
    const result = enforcePluginOps(declaration, "net.fetch");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.op, "net.fetch");
  });

  test("another allowed op succeeds", () => {
    const result = enforcePluginOps(declaration, "db.query");
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.op, "db.query");
  });

  // -------------------------------------------------------------------------
  // 8. Undeclared op is rejected
  // -------------------------------------------------------------------------
  test("undeclared op is rejected", () => {
    const result = enforcePluginOps(declaration, "exec.spawn");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.op, "exec.spawn");
    assert.ok(result.reason, "should include a rejection reason");
    assert.ok(
      result.reason!.includes("exec.spawn"),
      `reason should mention the rejected op, got: ${result.reason}`,
    );
  });

  test("undeclared op with similar prefix is still rejected", () => {
    const result = enforcePluginOps(declaration, "net.socket");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.op, "net.socket");
  });
});
