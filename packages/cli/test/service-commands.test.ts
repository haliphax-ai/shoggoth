import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the invokeControlRequest function that CLI uses to communicate with daemon
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: vi.fn(),
}));

import { invokeControlRequest } from "@shoggoth/daemon/lib";
import {
  parseNoArgsCommand,
  parseServiceRequestArgs,
  parseServiceApproveArgs,
  parseServiceRevokeArgs,
} from "../src/run-service";

describe("run-service CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseNoArgsCommand", () => {
    it("parses empty args", () => {
      const result = parseNoArgsCommand([]);
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({});
    });

    it("rejects unexpected args", () => {
      const result = parseNoArgsCommand(["--verbose"]);
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
