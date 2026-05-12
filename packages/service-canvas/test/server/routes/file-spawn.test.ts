/**
 * File Spawn Router Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createFileSpawnRouter } from "../../../src/server/routes/file-spawn";
import * as fs from "fs/promises";

// Mock fs/promises
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("File Spawn Router", () => {
  let app: express.Application;
  const mockSessionsSpawn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/file-spawn", createFileSpawnRouter({ sessionsSpawn: mockSessionsSpawn }));
  });

  describe("POST /api/file-spawn", () => {
    it("should read the prompt file and call sessionsSpawn", async () => {
      const mockFileContent = "Prompt from file";
      vi.mocked(fs.readFile).mockResolvedValue(mockFileContent);

      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/file-spawn")
        .send({ file: "/path/to/prompt.txt" });

      expect(fs.readFile).toHaveBeenCalledWith("/path/to/prompt.txt", "utf-8");
      expect(mockSessionsSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: mockFileContent,
        }),
      );
      expect(response.status).toBe(200);
    });

    it("should validate file is required", async () => {
      const response = await request(app).post("/api/file-spawn").send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
    });

    it("should block path traversal (../ in file path)", async () => {
      const response = await request(app).post("/api/file-spawn").send({ file: "../etc/passwd" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("path traversal");
      expect(mockSessionsSpawn).not.toHaveBeenCalled();
    });

    it("should block path traversal with encoded characters", async () => {
      const response = await request(app)
        .post("/api/file-spawn")
        .send({ file: "..%2F..%2Fetc%2Fpasswd" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("path traversal");
    });

    it("should return { ok: true, result } on success", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("Prompt content");

      const mockResult = { ok: true, sessionId: "test-123" };
      mockSessionsSpawn.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/file-spawn")
        .send({ file: "/path/to/prompt.txt" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, result: mockResult });
    });
  });
});
