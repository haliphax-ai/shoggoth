import { describe, it, expect } from "vitest";
import { computeManifestFingerprint } from "../src/manifest-fingerprint";

describe("computeManifestFingerprint", () => {
  describe("deterministic hashing", () => {
    it("should produce the same hash for the same manifest and capabilities", () => {
      const manifest = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "test.tool",
            description: "A test tool",
            parameters: { type: "object" },
            method: "POST",
            path: "/api/test",
          },
        ],
        ops: ["test.op"],
      };

      const fp1 = computeManifestFingerprint(manifest, ["capability1"]);
      const fp2 = computeManifestFingerprint(manifest, ["capability1"]);

      expect(fp1).toBe(fp2);
    });

    it("should produce different hashes for different tools", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool.one",
            description: "Tool one",
            parameters: {},
            method: "POST",
            path: "/api/one",
          },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool.two",
            description: "Tool two",
            parameters: {},
            method: "POST",
            path: "/api/two",
          },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should produce different hashes for different capabilities", () => {
      const manifest = {
        name: "test-service",
        version: "1.0.0",
      };

      const fp1 = computeManifestFingerprint(manifest, ["cap1"]);
      const fp2 = computeManifestFingerprint(manifest, ["cap2"]);

      expect(fp1).not.toBe(fp2);
    });

    it("should produce different hashes for different ops", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        ops: ["op.one"],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        ops: ["op.two"],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe("key ordering independence", () => {
    it("should produce the same hash regardless of tool order", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool.alpha",
            description: "Alpha tool",
            parameters: {},
            method: "POST",
            path: "/api/alpha",
          },
          {
            name: "tool.beta",
            description: "Beta tool",
            parameters: {},
            method: "GET",
            path: "/api/beta",
          },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool.beta",
            description: "Beta tool",
            parameters: {},
            method: "GET",
            path: "/api/beta",
          },
          {
            name: "tool.alpha",
            description: "Alpha tool",
            parameters: {},
            method: "POST",
            path: "/api/alpha",
          },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).toBe(fp2);
    });

    it("should produce the same hash regardless of ops order", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        ops: ["z.op", "a.op", "m.op"],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        ops: ["a.op", "m.op", "z.op"],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).toBe(fp2);
    });

    it("should produce the same hash regardless of capabilities order", () => {
      const manifest = {
        name: "test-service",
        version: "1.0.0",
      };

      const fp1 = computeManifestFingerprint(manifest, ["z-cap", "a-cap", "m-cap"]);
      const fp2 = computeManifestFingerprint(manifest, ["a-cap", "m-cap", "z-cap"]);

      expect(fp1).toBe(fp2);
    });
  });

  describe("coverage verification", () => {
    it("should NOT include name in fingerprint", () => {
      const manifest1 = { name: "service-a", version: "1.0.0" };
      const manifest2 = { name: "service-b", version: "1.0.0" };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).toBe(fp2);
    });

    it("should NOT include version in fingerprint", () => {
      const manifest1 = { name: "test-service", version: "1.0.0" };
      const manifest2 = { name: "test-service", version: "2.0.0" };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).toBe(fp2);
    });

    it("should NOT include wsEndpoints in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        wsEndpoints: [{ path: "/ws", description: "WebSocket" }],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        wsEndpoints: [{ path: "/ws2", description: "WebSocket 2" }],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).toBe(fp2);
    });

    it("should include tool name in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [{ name: "tool.a", description: "A", parameters: {}, method: "POST", path: "/a" }],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [{ name: "tool.b", description: "A", parameters: {}, method: "POST", path: "/a" }],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should include tool description in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          { name: "tool", description: "desc-a", parameters: {}, method: "POST", path: "/a" },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          { name: "tool", description: "desc-b", parameters: {}, method: "POST", path: "/a" },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should include tool parameters in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool",
            description: "A",
            parameters: { type: "object", properties: { a: {} } },
            method: "POST",
            path: "/a",
          },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool",
            description: "A",
            parameters: { type: "object", properties: { b: {} } },
            method: "POST",
            path: "/a",
          },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should include tool method in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [{ name: "tool", description: "A", parameters: {}, method: "POST", path: "/a" }],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [{ name: "tool", description: "A", parameters: {}, method: "GET", path: "/a" }],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should include tool path in fingerprint", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          { name: "tool", description: "A", parameters: {}, method: "POST", path: "/api/one" },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          { name: "tool", description: "A", parameters: {}, method: "POST", path: "/api/two" },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });

    it("should include tool dispatch in fingerprint when present", () => {
      const manifest1 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool",
            description: "A",
            parameters: {},
            method: "POST",
            path: "/a",
            dispatch: "body",
          },
        ],
      };

      const manifest2 = {
        name: "test-service",
        version: "1.0.0",
        tools: [
          {
            name: "tool",
            description: "A",
            parameters: {},
            method: "POST",
            path: "/a",
            dispatch: "query",
          },
        ],
      };

      const fp1 = computeManifestFingerprint(manifest1, []);
      const fp2 = computeManifestFingerprint(manifest2, []);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe("edge cases", () => {
    it("should handle empty tools array", () => {
      const manifest = { name: "test-service", version: "1.0.0", tools: [] };
      const fp = computeManifestFingerprint(manifest, []);
      expect(fp).toBeDefined();
      expect(typeof fp).toBe("string");
    });

    it("should handle undefined tools", () => {
      const manifest = { name: "test-service", version: "1.0.0" };
      const fp = computeManifestFingerprint(manifest, []);
      expect(fp).toBeDefined();
    });

    it("should handle undefined ops", () => {
      const manifest = { name: "test-service", version: "1.0.0" };
      const fp = computeManifestFingerprint(manifest, []);
      expect(fp).toBeDefined();
    });

    it("should handle empty capabilities array", () => {
      const manifest = { name: "test-service", version: "1.0.0" };
      const fp = computeManifestFingerprint(manifest, []);
      expect(fp).toBeDefined();
    });

    it("should produce a valid SHA-256 hex string", () => {
      const manifest = { name: "test-service", version: "1.0.0" };
      const fp = computeManifestFingerprint(manifest, []);
      // SHA-256 produces 64 hex characters
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
