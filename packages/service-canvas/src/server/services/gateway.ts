/**
 * Canvas Gateway Service
 */

import type { Server } from "http";

export interface SpaSession {
  id: string;
}

interface PendingSnapshot {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class Gateway {
  private clients: Map<string, Set<WebSocket>> = new Map();
  private wss: WebSocketServer | null = null;
  private pendingSnapshots: Map<string, PendingSnapshot> = new Map();

  constructor(options?: { server?: Server }) {
    // Initialize without starting WebSocket server - methods are no-ops if no clients
    // The server parameter can be used later to attach WS if needed
    if (options?.server) {
      this.attachToServer(options.server);
    }
  }

  private attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ server });

    this.wss.on("connection", (ws, req) => {
      // Extract session ID from URL query params
      const url = new URL(req.url ?? "", "http://localhost");
      const sessionId = url.searchParams.get("session");

      if (!sessionId) {
        ws.close();
        return;
      }

      // Add client to session's client set
      if (!this.clients.has(sessionId)) {
        this.clients.set(sessionId, new Set());
      }
      this.clients.get(sessionId)!.add(ws);

      ws.on("close", () => {
        this.clients.get(sessionId)?.delete(ws);
        if (this.clients.get(sessionId)?.size === 0) {
          this.clients.delete(sessionId);
        }
      });

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle snapshot responses
          if (message.type === "snapshot" && message.sessionId) {
            const pending = this.pendingSnapshots.get(message.sessionId);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingSnapshots.delete(message.sessionId);
              pending.resolve(message.data || "");
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });
  }

  broadcastSpaSession(session: string | SpaSession, message: unknown): void {
    const sessionId = typeof session === "string" ? session : session.id;
    const clients = this.clients.get(sessionId);

    if (!clients || clients.size === 0) return;

    const data = JSON.stringify(message);

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  broadcastSpa(message: unknown): void {
    const data = JSON.stringify(message);

    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    }
  }

  requestSnapshot(session: string | SpaSession): Promise<string> {
    const sessionId = typeof session === "string" ? session : session.id;

    // Request snapshot from the SPA session
    this.broadcastSpaSession(sessionId, { type: "requestSnapshot" });

    // Return a promise that resolves after 30 seconds if no response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSnapshots.delete(sessionId);
        resolve(""); // Return empty string on timeout
      }, 30000);

      this.pendingSnapshots.set(sessionId, { resolve, reject, timeout });
    });
  }

  close(): void {
    // Close all client connections
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Clear any pending snapshots
    for (const pending of this.pendingSnapshots.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingSnapshots.clear();
  }
}

// Import WebSocketServer at the top level for proper typing
import { WebSocketServer, WebSocket } from "ws";
