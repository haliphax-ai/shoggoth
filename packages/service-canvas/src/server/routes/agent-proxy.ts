/**
 * Agent Proxy Router
 */

import { Router, type Request, type Response, type NextFunction } from "express";

// Lazy loader for sessionsSpawn - allows vi.mock to work in tests
let _sessionsSpawn: Function | undefined;
async function getSessionsSpawn(): Promise<Function> {
  if (!_sessionsSpawn) {
    const plugin = await import("../../../src/plugin.js");
    _sessionsSpawn = plugin.sessionsSpawn;
  }
  return _sessionsSpawn;
}

export interface AgentProxyOptions {
  sessionsSpawn?: Function;
}

export function createAgentProxyRouter(opts?: AgentProxyOptions): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { message, agentId, model, timeoutSeconds, sessionKey } = req.body;

      // Validate message is required
      if (message === undefined || message === null || message === "") {
        res.status(400).json({ error: "message is required" });
        return;
      }

      // Get sessionsSpawn - from opts, or lazy-load from plugin module
      let spawnFn: Function;
      if (opts?.sessionsSpawn) {
        spawnFn = opts.sessionsSpawn;
      } else {
        spawnFn = await getSessionsSpawn();
      }

      // Build the sessionsSpawn call - pass through keys as-is
      const spawnOptions: Record<string, unknown> = {
        message: message,
        mode: "run",
      };

      if (agentId !== undefined) {
        spawnOptions.agentId = agentId;
      }
      if (model !== undefined) {
        spawnOptions.model = model;
      }
      if (timeoutSeconds !== undefined) {
        spawnOptions.timeoutSeconds = timeoutSeconds;
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
