/**
 * Agent Proxy Router Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAgentProxyRouter } from "../../../src/server/routes/agent-proxy";

describe("Agent Proxy Router", () => {
  let app: express.Application;
  const mockSessionsSpawn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/agent", createAgentProxyRouter({ sessionsSpawn: mockSessionsSpawn }));
  });

  describe("POST /api/agent", () => {
    it("should call sessionsSpawn with correct args", async () => {
      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      const response = await request(app).post("/api/agent").send({ message: "Hello agent" });

      expect(mockSessionsSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Hello agent",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("should validate message is required", async () => {
      const response = await request(app).post("/api/agent").send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });

    it("should pass optional agentId", async () => {
      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      await request(app).post("/api/agent").send({ message: "Hello", agentId: "my-agent" });

      expect(mockSessionsSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "my-agent",
        }),
      );
    });

    it("should pass optional model", async () => {
      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      await request(app).post("/api/agent").send({ message: "Hello", model: "claude-3" });

      expect(mockSessionsSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-3",
        }),
      );
    });

    it("should pass optional timeoutSeconds", async () => {
      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      await request(app).post("/api/agent").send({ message: "Hello", timeoutSeconds: 60 });

      expect(mockSessionsSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSeconds: 60,
        }),
      );
    });

    it("should return { ok: true, result } on success", async () => {
      const mockResult = { ok: true, sessionId: "test-123", response: "Hi" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      const response = await request(app).post("/api/agent").send({ message: "Hello" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, result: mockResult });
    });
  });
});
