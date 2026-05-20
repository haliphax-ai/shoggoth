import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExternalServiceHealthPoller,
  ExternalServiceDeclaration,
  TcpHealthChecker,
  HttpHealthChecker,
} from "../src/external-service-health-poller";

describe("ExternalServiceHealthPoller", () => {
  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };

  let poller: ExternalServiceHealthPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    poller = new ExternalServiceHealthPoller(mockLogger);
  });

  afterEach(() => {
    poller.stopAll();
    vi.useRealTimers();
  });

  describe("getState", () => {
    it("returns unknown for untracked services", () => {
      expect(poller.getState("unknown-service")).toBe("unknown");
    });
  });

  describe("getTrackedIds", () => {
    it("returns empty array initially", () => {
      expect(poller.getTrackedIds()).toEqual([]);
    });

    it("returns all tracked service IDs", () => {
      const decl1: ExternalServiceDeclaration = {
        id: "service-1",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      };
      const decl2: ExternalServiceDeclaration = {
        id: "service-2",
        host: "localhost",
        port: 3001,
        protocol: "http",
        health: { kind: "tcp" },
      };
      poller.add(decl1);
      poller.add(decl2);
      expect(poller.getTrackedIds()).toContain("service-1");
      expect(poller.getTrackedIds()).toContain("service-2");
    });
  });

  describe("lifecycle - add/remove/stopAll", () => {
    it("add starts polling for a service", () => {
      const declaration: ExternalServiceDeclaration = {
        id: "test-service",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      };
      poller.add(declaration);
      expect(poller.getTrackedIds()).toContain("test-service");
    });

    it("remove stops polling for a service", () => {
      const declaration: ExternalServiceDeclaration = {
        id: "test-service",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      };
      poller.add(declaration);
      poller.remove("test-service");
      expect(poller.getTrackedIds()).not.toContain("test-service");
    });

    it("stopAll stops all pollers", () => {
      const decl1: ExternalServiceDeclaration = {
        id: "service-1",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      };
      const decl2: ExternalServiceDeclaration = {
        id: "service-2",
        host: "localhost",
        port: 3001,
        protocol: "http",
        health: { kind: "tcp" },
      };
      poller.add(decl1);
      poller.add(decl2);
      poller.stopAll();
      expect(poller.getTrackedIds()).toEqual([]);
    });

    it("update modifies existing service configuration", () => {
      const declaration: ExternalServiceDeclaration = {
        id: "test-service",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
        healthIntervalMs: 5000,
      };
      poller.add(declaration);

      const updatedDeclaration: ExternalServiceDeclaration = {
        ...declaration,
        healthIntervalMs: 10000,
      };
      poller.update(updatedDeclaration);

      expect(poller.getTrackedIds()).toContain("test-service");
    });
  });

  describe("TCP health check (mocked)", () => {
    it("successful connection marks healthy on first check", async () => {
      // Mock the TCP checker to return success
      const tcpSpy = vi.spyOn(TcpHealthChecker.prototype, "check").mockResolvedValue(true);

      const declaration: ExternalServiceDeclaration = {
        id: "tcp-healthy",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
        unhealthyThreshold: 1,
        healthIntervalMs: 10000,
      };

      poller.add(declaration);

      // Let the immediate health check resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.getState("tcp-healthy")).toBe("healthy");
      tcpSpy.mockRestore();
    });

    it("connection refused marks unhealthy after threshold", async () => {
      const tcpSpy = vi.spyOn(TcpHealthChecker.prototype, "check").mockResolvedValue(false);

      const declaration: ExternalServiceDeclaration = {
        id: "tcp-unhealthy",
        host: "localhost",
        port: 59999,
        protocol: "http",
        health: { kind: "tcp", timeoutMs: 100 },
        unhealthyThreshold: 3,
        healthIntervalMs: 100,
      };

      poller.add(declaration);

      // Initial check (failure 1)
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.getState("tcp-unhealthy")).toBe("unknown");

      // Second check (failure 2)
      await vi.advanceTimersByTimeAsync(100);
      expect(poller.getState("tcp-unhealthy")).toBe("unknown");

      // Third check (failure 3 = threshold)
      await vi.advanceTimersByTimeAsync(100);
      expect(poller.getState("tcp-unhealthy")).toBe("unhealthy");

      tcpSpy.mockRestore();
    });
  });

  describe("HTTP health check (mocked)", () => {
    it("200 response marks healthy on first check", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: true });

      const declaration: ExternalServiceDeclaration = {
        id: "http-healthy",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
          expectedStatus: 200,
        },
        unhealthyThreshold: 1,
        healthIntervalMs: 10000,
      };

      poller.add(declaration);
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.getState("http-healthy")).toBe("healthy");
      httpSpy.mockRestore();
    });

    it("non-200 response marks unhealthy after threshold", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: false, error: new Error("HTTP 503") });

      const declaration: ExternalServiceDeclaration = {
        id: "http-unhealthy",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
          expectedStatus: 200,
        },
        unhealthyThreshold: 3,
        healthIntervalMs: 100,
      };

      poller.add(declaration);

      // 3 failures needed
      await vi.advanceTimersByTimeAsync(0); // failure 1
      await vi.advanceTimersByTimeAsync(100); // failure 2
      await vi.advanceTimersByTimeAsync(100); // failure 3

      expect(poller.getState("http-unhealthy")).toBe("unhealthy");
      httpSpy.mockRestore();
    });

    it("timeout marks unhealthy after threshold", async () => {
      const httpSpy = vi.spyOn(HttpHealthChecker.prototype, "check").mockResolvedValue({
        success: false,
        error: new Error("Request timeout"),
      });

      const declaration: ExternalServiceDeclaration = {
        id: "http-timeout",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
          timeoutMs: 50,
        },
        unhealthyThreshold: 3,
        healthIntervalMs: 100,
      };

      poller.add(declaration);

      await vi.advanceTimersByTimeAsync(0); // failure 1
      await vi.advanceTimersByTimeAsync(100); // failure 2
      await vi.advanceTimersByTimeAsync(100); // failure 3

      expect(poller.getState("http-timeout")).toBe("unhealthy");
      httpSpy.mockRestore();
    });
  });

  describe("backoff", () => {
    it("interval doubles after consecutive failures beyond threshold", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: false, error: new Error("HTTP 503") });

      const initialInterval = 100;

      const declaration: ExternalServiceDeclaration = {
        id: "backoff-test",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
        },
        healthIntervalMs: initialInterval,
        unhealthyThreshold: 2,
      };

      poller.add(declaration);

      // Initial check (failure 1)
      await vi.advanceTimersByTimeAsync(0);
      // failure 2 (hits threshold, triggers backoff to 200ms)
      await vi.advanceTimersByTimeAsync(100);

      expect(poller.getState("backoff-test")).toBe("unhealthy");

      // The interval should now be 200ms. Advance by 200ms for next check.
      // failure 3 (backoff to 400ms)
      await vi.advanceTimersByTimeAsync(200);

      // Verify it's still being polled (check count increases)
      expect(httpSpy).toHaveBeenCalledTimes(3);

      httpSpy.mockRestore();
    });

    it("interval caps at maxBackoffMs (300000)", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: false, error: new Error("HTTP 503") });

      const declaration: ExternalServiceDeclaration = {
        id: "backoff-cap-test",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
        },
        // Start with a large interval so it hits the cap quickly
        healthIntervalMs: 200000,
        unhealthyThreshold: 1,
      };

      poller.add(declaration);

      // Initial check (failure 1 = threshold, backoff to 300000 which is the cap)
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.getState("backoff-cap-test")).toBe("unhealthy");

      // Next check should be at 300000ms (capped), not 400000
      await vi.advanceTimersByTimeAsync(300000);
      // Should have gotten another check
      expect(httpSpy).toHaveBeenCalledTimes(2);

      httpSpy.mockRestore();
    });

    it("resets to configured value on recovery", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: false, error: new Error("HTTP 503") });

      const declaration: ExternalServiceDeclaration = {
        id: "recovery-test",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
        },
        healthIntervalMs: 100,
        unhealthyThreshold: 2,
      };

      poller.add(declaration);

      // Fail to unhealthy
      await vi.advanceTimersByTimeAsync(0); // failure 1
      await vi.advanceTimersByTimeAsync(100); // failure 2 → unhealthy, backoff to 200

      expect(poller.getState("recovery-test")).toBe("unhealthy");

      // Now recover
      httpSpy.mockResolvedValue({ success: true });

      // Next check at 200ms (backed off interval)
      await vi.advanceTimersByTimeAsync(200);

      expect(poller.getState("recovery-test")).toBe("healthy");

      // After recovery, interval should be back to 100ms
      // Advance 100ms and verify another check happens
      const callsBefore = httpSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(httpSpy).toHaveBeenCalledTimes(callsBefore + 1);

      httpSpy.mockRestore();
    });
  });

  describe("events", () => {
    it("emits healthy event on first success", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: true });

      const healthyHandler = vi.fn();
      poller.on("healthy", healthyHandler);

      const declaration: ExternalServiceDeclaration = {
        id: "event-healthy",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
        },
        unhealthyThreshold: 1,
        healthIntervalMs: 10000,
      };

      poller.add(declaration);
      await vi.advanceTimersByTimeAsync(0);

      expect(healthyHandler).toHaveBeenCalledWith(
        "event-healthy",
        expect.objectContaining({ id: "event-healthy" }),
      );

      httpSpy.mockRestore();
    });

    it("emits unhealthy event after threshold failures", async () => {
      const tcpSpy = vi.spyOn(TcpHealthChecker.prototype, "check").mockResolvedValue(false);

      const unhealthyHandler = vi.fn();
      poller.on("unhealthy", unhealthyHandler);

      const declaration: ExternalServiceDeclaration = {
        id: "event-unhealthy",
        host: "localhost",
        port: 59998,
        protocol: "http",
        health: {
          kind: "tcp",
          timeoutMs: 50,
        },
        unhealthyThreshold: 3,
        healthIntervalMs: 100,
      };

      poller.add(declaration);

      await vi.advanceTimersByTimeAsync(0); // failure 1
      await vi.advanceTimersByTimeAsync(100); // failure 2
      await vi.advanceTimersByTimeAsync(100); // failure 3

      expect(unhealthyHandler).toHaveBeenCalledWith("event-unhealthy", expect.any(Error));

      tcpSpy.mockRestore();
    });

    it("does not emit healthy again if already healthy", async () => {
      const httpSpy = vi
        .spyOn(HttpHealthChecker.prototype, "check")
        .mockResolvedValue({ success: true });

      const healthyHandler = vi.fn();
      poller.on("healthy", healthyHandler);

      const declaration: ExternalServiceDeclaration = {
        id: "no-double-healthy",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: {
          kind: "http",
          url: "http://localhost:3000/health",
        },
        healthIntervalMs: 100,
      };

      poller.add(declaration);
      await vi.advanceTimersByTimeAsync(0); // first success → emit
      await vi.advanceTimersByTimeAsync(100); // second success → no emit

      expect(healthyHandler).toHaveBeenCalledTimes(1);

      httpSpy.mockRestore();
    });
  });
});
