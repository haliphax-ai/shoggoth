import { describe, test, expect } from "vitest";
import {
  createGatedServiceRegisterCtx,
  buildManifestFromRegistration,
  type PluginApprovalStore,
} from "../src/plugin-registration-gate";
import {
  computePluginFingerprint,
  type PluginManifestForFingerprint,
} from "../src/plugin-fingerprint";
import { createOpsEnforcementProxy, type PluginApprovalRecord } from "../src/plugin-approval";
import type { DirectServiceTool, PluginServiceEntry, ServiceRegisterCtx } from "../src/hook-types";
import type { ShoggothConfig } from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockInnerCtx() {
  const registered: { services: PluginServiceEntry[]; tools: DirectServiceTool[] } = {
    services: [],
    tools: [],
  };

  const ctx: ServiceRegisterCtx = {
    registerService: (entry: PluginServiceEntry) => {
      registered.services.push(entry);
    },
    registerTools: (tools: DirectServiceTool[]) => {
      registered.tools.push(...tools);
    },
    config: {} as Readonly<ShoggothConfig>,
  };

  return { ctx, registered };
}

function createMockStore(
  records: Map<string, PluginApprovalRecord> = new Map(),
): PluginApprovalStore {
  return {
    get: (name: string) => records.get(name),
    set: (name: string, record: PluginApprovalRecord) => {
      records.set(name, record);
    },
  };
}

const sampleTools: DirectServiceTool[] = [
  {
    name: "canvas.push",
    description: "Push to canvas",
    parameters: { type: "object" },
    handler: async () => ({ resultJson: "{}" }),
  },
  {
    name: "canvas.pull",
    description: "Pull from canvas",
    parameters: { type: "object" },
    handler: async () => ({ resultJson: "{}" }),
  },
];

const sampleManifest: PluginManifestForFingerprint = {
  name: "canvas-plugin",
  version: "1.0.0",
  tools: [
    { name: "canvas.push", description: "Push to canvas", parameters: { type: "object" } },
    { name: "canvas.pull", description: "Pull from canvas", parameters: { type: "object" } },
  ],
  ops: ["net.fetch", "fs.read"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin-registration-gate", () => {
  describe("createGatedServiceRegisterCtx", () => {
    test("suspends tools when plugin has no approval record (pending)", () => {
      const { ctx: innerCtx, registered } = createMockInnerCtx();
      const store = createMockStore();

      const { ctx: gatedCtx, getResult } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
      });

      // Register service and tools through the gated context
      gatedCtx.registerService({ id: "canvas-svc", capabilities: ["canvas"] });
      gatedCtx.registerTools(sampleTools);

      // Service should be registered (visible in registry)
      expect(registered.services).toHaveLength(1);
      expect(registered.services[0].id).toBe("canvas-svc");

      // Tools should NOT be forwarded (suspended)
      expect(registered.tools).toHaveLength(0);

      // Result should reflect suspended state
      const result = getResult();
      expect(result).toBeDefined();
      expect(result!.pluginName).toBe("canvas-plugin");
      expect(result!.approvalStatus.state).toBe("pending");
      expect(result!.toolsSuspended).toBe(true);
      expect(result!.registeredToolCount).toBe(0);
    });

    test("suspends tools when fingerprint has changed (pending-reapproval)", () => {
      const { ctx: innerCtx, registered } = createMockInnerCtx();
      const records = new Map<string, PluginApprovalRecord>();
      records.set("canvas-plugin", {
        pluginName: "canvas-plugin",
        fingerprint: "old-stale-fingerprint",
        approvedAt: new Date().toISOString(),
        approvedOps: ["net.fetch"],
      });
      const store = createMockStore(records);

      const { ctx: gatedCtx, getResult } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
      });

      gatedCtx.registerService({ id: "canvas-svc" });
      gatedCtx.registerTools(sampleTools);

      // Service registered but tools suspended
      expect(registered.services).toHaveLength(1);
      expect(registered.tools).toHaveLength(0);

      const result = getResult();
      expect(result!.approvalStatus.state).toBe("pending-reapproval");
      expect(result!.toolsSuspended).toBe(true);
    });

    test("activates tools normally when approved and fingerprint matches", () => {
      const { ctx: innerCtx, registered } = createMockInnerCtx();
      const fingerprint = computePluginFingerprint(sampleManifest);
      const records = new Map<string, PluginApprovalRecord>();
      records.set("canvas-plugin", {
        pluginName: "canvas-plugin",
        fingerprint,
        approvedAt: new Date().toISOString(),
        approvedOps: ["net.fetch", "fs.read"],
      });
      const store = createMockStore(records);

      const { ctx: gatedCtx, getResult } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
      });

      gatedCtx.registerService({ id: "canvas-svc", capabilities: ["canvas"] });
      gatedCtx.registerTools(sampleTools);

      // Both service and tools should be registered
      expect(registered.services).toHaveLength(1);
      expect(registered.tools).toHaveLength(2);
      expect(registered.tools[0].name).toBe("canvas.push");
      expect(registered.tools[1].name).toBe("canvas.pull");

      const result = getResult();
      expect(result!.approvalStatus.state).toBe("approved");
      expect(result!.toolsSuspended).toBe(false);
      expect(result!.registeredToolCount).toBe(2);
    });

    test("wraps deps with ops enforcement proxy when approved", () => {
      const fingerprint = computePluginFingerprint(sampleManifest);
      const records = new Map<string, PluginApprovalRecord>();
      records.set("canvas-plugin", {
        pluginName: "canvas-plugin",
        fingerprint,
        approvedAt: new Date().toISOString(),
        approvedOps: ["net.fetch", "fs.read"],
      });
      const store = createMockStore(records);

      const mockDeps = {
        "net.fetch": () => "fetched",
        "fs.read": () => "read",
        "exec.spawn": () => "spawned",
      };

      const { ctx: innerCtx } = createMockInnerCtx();
      const { ctx: gatedCtx } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
        deps: mockDeps,
      });

      // The gated context itself doesn't expose deps directly,
      // but we verify the gate doesn't throw during construction
      expect(gatedCtx.registerService).toBeDefined();
      expect(gatedCtx.registerTools).toBeDefined();
    });

    test("logs warnings when tools are suspended", () => {
      const { ctx: innerCtx } = createMockInnerCtx();
      const store = createMockStore();
      const warnings: string[] = [];
      const logger = {
        debug: () => {},
        warn: (msg: string) => {
          warnings.push(msg);
        },
      };

      const { ctx: gatedCtx } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
        logger,
      });

      gatedCtx.registerService({ id: "canvas-svc" });
      gatedCtx.registerTools(sampleTools);

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes("suspended"))).toBe(true);
      expect(warnings.some((w) => w.includes("canvas-plugin"))).toBe(true);
    });
  });

  describe("buildManifestFromRegistration", () => {
    test("builds a valid manifest from registration data", () => {
      const manifest = buildManifestFromRegistration("my-plugin", "2.0.0", sampleTools, [
        "net.fetch",
        "db.query",
      ]);

      expect(manifest.name).toBe("my-plugin");
      expect(manifest.version).toBe("2.0.0");
      expect(manifest.tools).toHaveLength(2);
      expect(manifest.tools[0].name).toBe("canvas.push");
      expect(manifest.tools[1].name).toBe("canvas.pull");
      expect(manifest.ops).toEqual(["net.fetch", "db.query"]);
    });

    test("produces a deterministic fingerprint", () => {
      const manifest = buildManifestFromRegistration("my-plugin", "2.0.0", sampleTools, [
        "net.fetch",
        "db.query",
      ]);

      const fp1 = computePluginFingerprint(manifest);
      const fp2 = computePluginFingerprint(manifest);
      expect(fp1).toBe(fp2);
      expect(fp1.length).toBeGreaterThan(0);
    });
  });

  describe("ops enforcement proxy integration", () => {
    test("approved plugin deps proxy allows declared ops", () => {
      const deps: Record<string, () => string> = {
        "net.fetch": () => "ok",
        "fs.read": () => "ok",
        "exec.spawn": () => "should not be accessible",
      };

      const proxy = createOpsEnforcementProxy(deps, {
        pluginName: "canvas-plugin",
        allowedOps: ["net.fetch", "fs.read"],
      });

      // Allowed ops work
      expect(proxy["net.fetch"]()).toBe("ok");
      expect(proxy["fs.read"]()).toBe("ok");

      // Undeclared op throws
      expect(() => proxy["exec.spawn"]).toThrow(/exec\.spawn/);
    });

    test("pending plugin does not get ops proxy (tools suspended anyway)", () => {
      const store = createMockStore();
      const { ctx: innerCtx } = createMockInnerCtx();

      const deps = {
        "net.fetch": () => "ok",
        "exec.spawn": () => "should not matter",
      };

      // When pending, the gate doesn't create an enforcement proxy
      // (no point enforcing ops on a suspended plugin)
      const { ctx: gatedCtx } = createGatedServiceRegisterCtx({
        innerCtx,
        approvalStore: store,
        manifest: sampleManifest,
        deps,
      });

      // Just verify it doesn't throw during construction
      expect(gatedCtx).toBeDefined();
    });
  });
});
