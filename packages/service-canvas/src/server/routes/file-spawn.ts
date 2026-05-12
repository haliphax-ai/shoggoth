/**
 * File Spawn Router
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import * as fs from "fs/promises";
import * as path from "path";

// Lazy loader for sessionsSpawn - allows vi.mock to work in tests
let _sessionsSpawn: Function | undefined;
async function getSessionsSpawn(): Promise<Function> {
  if (!_sessionsSpawn) {
    const plugin = await import("../../../src/plugin.js");
    _sessionsSpawn = plugin.sessionsSpawn;
  }
  return _sessionsSpawn;
}

export interface FileSpawnOptions {
  sessionsSpawn?: Function;
  canvasRoot?: string;
}

export function createFileSpawnRouter(opts?: FileSpawnOptions): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { file, agentId, model, sessionKey } = req.body;

      // Validate file is required
      if (file === undefined || file === null || file === "") {
        res.status(400).json({ error: "file is required" });
        return;
      }

      // Get sessionsSpawn - from opts, or lazy-load from plugin module
      const spawnFn = opts?.sessionsSpawn ?? (await getSessionsSpawn());

      // Decode URL-encoded characters (e.g., %2F -> /)
      const decodedFile = decodeURIComponent(file);

      // Block path traversal - check for .. (after decoding)
      if (decodedFile.includes("..")) {
        res.status(400).json({ error: "path traversal detected" });
        return;
      }

      // Additional check: if canvasRoot is provided and path is absolute, verify it's within canvasRoot
      if (opts?.canvasRoot && path.isAbsolute(decodedFile)) {
        const resolvedPath = path.resolve(decodedFile);
        const resolvedRoot = path.resolve(opts.canvasRoot);

        // Only allow absolute paths that are within canvasRoot
        if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
          res.status(400).json({ error: "path traversal detected" });
          return;
        }
      }

      // Read file content
      const fileContent = await fs.readFile(decodedFile, "utf-8");

      // Build the sessionsSpawn call - use 'message' key to match test expectations
      const spawnOptions: Record<string, unknown> = {
        message: fileContent,
        mode: "run",
      };

      if (agentId !== undefined) {
        spawnOptions.agentId = agentId;
      }
      if (model !== undefined) {
        spawnOptions.model = model;
      }
      if (sessionKey !== undefined) {
        spawnOptions.sessionKey = sessionKey;
      }

      const result = await spawnFn(spawnOptions);
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
