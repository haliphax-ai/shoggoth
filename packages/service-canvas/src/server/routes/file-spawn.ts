/**
 * File Spawn Router
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import * as fs from "fs/promises";
import * as path from "path";

export interface FileSpawnOptions {
  sessionsSpawn: Function;
  canvasRoot: string;
  agentWorkspaceMap?: Map<string, string>;
}

export function createFileSpawnRouter(opts: FileSpawnOptions): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { file, agentId, model, sessionKey } = req.body;

      // Validate file is required
      if (file === undefined || file === null || file === "") {
        res.status(400).json({ error: "file is required" });
        return;
      }

      // Decode URL-encoded characters (e.g., %2F -> /)
      const decodedFile = decodeURIComponent(file);

      // Block path traversal - check for .. (after decoding)
      if (decodedFile.includes("..")) {
        res.status(400).json({ error: "path traversal detected" });
        return;
      }

      // Resolve root based on agentId
      const root = (agentId && opts.agentWorkspaceMap?.get(agentId)) ?? opts.canvasRoot;

      // Resolve relative paths against the root; absolute paths are validated below
      const resolved = path.isAbsolute(decodedFile)
        ? path.resolve(decodedFile)
        : path.resolve(root, decodedFile);

      // Resolve symlinks so the containment check sees the real target
      let real: string;
      try {
        real = await fs.realpath(resolved);
      } catch {
        res.status(404).json({ error: "file not found" });
        return;
      }

      let realRoot: string;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        res.status(404).json({ error: "file not found" });
        return;
      }

      // Verify the real path is within the root
      if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
        res.status(400).json({ error: "path traversal detected" });
        return;
      }

      // Read file content
      let fileContent: string;
      try {
        fileContent = await fs.readFile(real, "utf-8");
      } catch {
        res.status(404).json({ error: "file not found" });
        return;
      }

      // Build the sessionsSpawn call
      const spawnOptions: Record<string, unknown> = {
        message: fileContent,
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

      const result = await opts.sessionsSpawn(spawnOptions);
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
