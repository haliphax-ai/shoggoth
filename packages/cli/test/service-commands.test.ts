import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the invokeControlRequest function that CLI uses to communicate with daemon
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: vi.fn(),
}));

import { invokeControlRequest } from "@shoggoth/daemon/lib";
import {
  parseServiceListArgs,
  parseServiceRequestsArgs,
  parseServiceRequestArgs,
  parseServiceApproveArgs,
  parseServiceRevokeArgs,
  formatServiceListOutput,
  formatServiceRequestsOutput,
  formatServiceRequestOutput,
  formatServiceApproveOutput,
  formatServiceRevokeOutput,
} from "../src/run-service";

describe("run-service CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseServiceListArgs", () => {
    it("parses empty args for list command", () => {
      const result = parseServiceListArgs([]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({});
    });

    it("rejects unexpected args", () => {
      const result = parseServiceListArgs(["--verbose"]);
      expect(result.ok).toBe(false);
    });
  });

  describe("parseServiceRequestsArgs", () => {
    it("parses empty args for requests command", () => {
      const result = parseServiceRequestsArgs([]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({});
    });

    it("rejects unexpected args", () => {
      const result = parseServiceRequestsArgs(["--all"]);
      expect(result.ok).toBe(false);
    });
  });

  describe("parseServiceRequestArgs", () => {
    it("parses service id argument", () => {
      const result = parseServiceRequestArgs(["my-service"]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ service_id: "my-service" });
    });

    it("rejects missing service id", () => {
      const result = parseServiceRequestArgs([]);
      expect(result.ok).toBe(false);
    });
  });

  describe("parseServiceApproveArgs", () => {
    it("parses service id argument", () => {
      const result = parseServiceApproveArgs(["my-service"]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ service_id: "my-service" });
    });

    it("rejects missing service id", () => {
      const result = parseServiceApproveArgs([]);
      expect(result.ok).toBe(false);
    });

    it("parses --fingerprint option", () => {
      const result = parseServiceApproveArgs(["my-service", "--fingerprint", "abc123"]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ service_id: "my-service", fingerprint: "abc123" });
    });
  });

  describe("parseServiceRevokeArgs", () => {
    it("parses service id argument", () => {
      const result = parseServiceRevokeArgs(["my-service"]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ service_id: "my-service" });
    });

    it("rejects missing service id", () => {
      const result = parseServiceRevokeArgs([]);
      expect(result.ok).toBe(false);
    });

    it("parses --force option", () => {
      const result = parseServiceRevokeArgs(["my-service", "--force"]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({ service_id: "my-service", force: true });
    });
  });

  describe("formatServiceListOutput", () => {
    it("formats services as a table", () => {
      const services = [
        {
          id: "svc-1",
          tier: "managed",
          status: "approved",
          tools: 2,
          capabilities: ["cap1", "cap2"],
          url: "http://localhost:8080",
          healthy: true,
        },
        {
          id: "svc-2",
          tier: "external",
          status: "pending",
          tools: 0,
          capabilities: ["cap3"],
          url: "http://external:9000",
          healthy: true,
        },
      ];

      const output = formatServiceListOutput(services);

      expect(output).toContain("svc-1");
      expect(output).toContain("managed");
      expect(output).toContain("approved");
      expect(output).toContain("svc-2");
      expect(output).toContain("external");
      expect(output).toContain("pending");
    });

    it("shows capabilities count when list is empty", () => {
      const output = formatServiceListOutput([]);
      expect(output).toContain("No services");
    });
  });

  describe("formatServiceRequestsOutput", () => {
    it("formats pending requests as a table", () => {
      const requests = [
        {
          id: "svc-pending",
          status: "pending",
          label: "Pending Service",
          tier: "managed",
          capabilities: ["cap1"],
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "svc-reapproval",
          status: "pending-reapproval",
          label: "Reapproval Service",
          tier: "managed",
          capabilities: ["cap2"],
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ];

      const output = formatServiceRequestsOutput(requests);

      expect(output).toContain("svc-pending");
      expect(output).toContain("pending");
      expect(output).toContain("svc-reapproval");
      expect(output).toContain("pending-reapproval");
    });

    it("shows message when no pending requests", () => {
      const output = formatServiceRequestsOutput([]);
      expect(output).toContain("No pending");
    });
  });

  describe("formatServiceRequestOutput", () => {
    it("formats service details with tools table", () => {
      const service = {
        id: "svc-1",
        label: "Test Service",
        tier: "managed",
        status: "pending",
        url: "http://localhost:8080",
        capabilities: ["cap1", "cap2"],
        ops: ["session_queue_manage", "vault.get"],
        tools: [
          { name: "tool1", description: "Tool 1", method: "POST", path: "/api/tool1" },
          { name: "tool2", description: "Tool 2", method: "GET", path: "/api/tool2" },
        ],
      };

      const output = formatServiceRequestOutput(service);

      expect(output).toContain("svc-1");
      expect(output).toContain("Test Service");
      expect(output).toContain("tool1");
      expect(output).toContain("POST");
      expect(output).toContain("/api/tool1");
      expect(output).toContain("cap1");
      expect(output).toContain("cap2");
    });

    it("shows diff section for pending-reapproval status", () => {
      const service = {
        id: "svc-1",
        label: "Test Service",
        tier: "managed",
        status: "pending-reapproval",
        url: "http://localhost:8080",
        capabilities: ["cap1"],
        ops: [],
        tools: [],
        diff: {
          oldFingerprint: "old-fp",
          newFingerprint: "new-fp",
          changes: ["Added tool 'newtool'", "Removed capability 'oldcap'"],
        },
      };

      const output = formatServiceRequestOutput(service);

      expect(output).toContain("old-fp");
      expect(output).toContain("new-fp");
      expect(output).toContain("Added tool");
      expect(output).toContain("Removed capability");
    });
  });

  describe("formatServiceApproveOutput", () => {
    it("formats approval confirmation", () => {
      const output = formatServiceApproveOutput("svc-1", true);

      expect(output).toContain("svc-1");
      expect(output).toContain("approved");
    });

    it("shows error on failure", () => {
      const output = formatServiceApproveOutput("svc-1", false, "Service not found");

      expect(output).toContain("svc-1");
      expect(output).toContain("not found");
    });
  });

  describe("formatServiceRevokeOutput", () => {
    it("formats revocation confirmation", () => {
      const output = formatServiceRevokeOutput("svc-1", true);

      expect(output).toContain("svc-1");
      expect(output).toContain("revoked");
    });

    it("shows error on failure", () => {
      const output = formatServiceRevokeOutput("svc-1", false, "Service not found");

      expect(output).toContain("svc-1");
      expect(output).toContain("not found");
    });
  });

  describe("integration with invokeControlRequest", () => {
    it("calls daemon for service list", async () => {
      vi.mocked(invokeControlRequest).mockResolvedValue({
        services: [
          { id: "svc-1", tier: "managed", status: "approved", tools: 2, capabilities: ["cap1"] },
        ],
      });

      const { runServiceListCli } = await import("../src/run-service");
      await runServiceListCli({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
      });

      expect(invokeControlRequest).toHaveBeenCalledWith({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
        op: "service.list",
        payload: {},
      });
    });

    it("calls daemon for service requests", async () => {
      vi.mocked(invokeControlRequest).mockResolvedValue({
        requests: [{ id: "svc-1", status: "pending" }],
      });

      const { runServiceRequestsCli } = await import("../src/run-service");
      await runServiceRequestsCli({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
      });

      expect(invokeControlRequest).toHaveBeenCalledWith({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
        op: "service.requests",
        payload: {},
      });
    });

    it("calls daemon for service request details", async () => {
      vi.mocked(invokeControlRequest).mockResolvedValue({
        service: {
          id: "svc-1",
          status: "pending",
          tools: [],
          capabilities: [],
          ops: [],
        },
      });

      const { runServiceRequestCli } = await import("../src/run-service");
      await runServiceRequestCli("svc-1", {
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
      });

      expect(invokeControlRequest).toHaveBeenCalledWith({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
        op: "service.request",
        payload: { service_id: "svc-1" },
      });
    });

    it("calls daemon for service approve", async () => {
      vi.mocked(invokeControlRequest).mockResolvedValue({ ok: true, service_id: "svc-1" });

      const { runServiceApproveCli } = await import("../src/run-service");
      await runServiceApproveCli("svc-1", {
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
      });

      expect(invokeControlRequest).toHaveBeenCalledWith({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
        op: "service.approve",
        payload: { service_id: "svc-1" },
      });
    });

    it("calls daemon for service revoke", async () => {
      vi.mocked(invokeControlRequest).mockResolvedValue({ ok: true, service_id: "svc-1" });

      const { runServiceRevokeCli } = await import("../src/run-service");
      await runServiceRevokeCli("svc-1", {
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
      });

      expect(invokeControlRequest).toHaveBeenCalledWith({
        socketPath: "/tmp/socket",
        auth: { kind: "operator_token", token: "test" },
        op: "service.revoke",
        payload: { service_id: "svc-1" },
      });
    });
  });
});
