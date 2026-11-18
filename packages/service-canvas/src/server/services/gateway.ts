/**
 * Canvas Gateway Service
 */

import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";

export interface SpaSession {
  id: string;
}

interface PendingSnapshot {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type CommandHandler = (
  msg: Record<string, unknown>,
  reply: (result: unknown) => void,
) => void | Promise<void>;

export class Gateway {
  private clients: Map<string, Set<WebSocket>> = new Map();
  private wss: WebSocketServer | null = null;
  private pendingSnapshots: Map<string, PendingSnapshot> = new Map();
  private handlers: Map<string, CommandHandler> = new Map();
  private spaConnectListeners: Array<(ws: WebSocket) => void> = [];
  private a2uiManager: unknown = null;
  private schemaResolver: unknown = null;

  /** Fallback session used when a message does not specify one. */
  private activeSession: string = "main";

  constructor(options?: { server?: Server }) {
    if (options?.server) {
      this.attachToServer(options.server);
    }
  }

  private attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ server });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const sessionId = url.searchParams.get("session");

      if (!sessionId) {
        ws.close();
        return;
      }

      if (!this.clients.has(sessionId)) {
        this.clients.set(sessionId, new Set());
      }
      this.clients.get(sessionId)!.add(ws);

      // Notify SPA connect listeners
      for (const listener of this.spaConnectListeners) {
        listener(ws);
      }

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

  /** Register a command handler */
  on(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  /** Dispatch a command and return the reply */
  dispatch(type: string, msg: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (!handler) {
      return Promise.resolve({ error: `No handler for ${type}` });
    }
    return new Promise((resolve) => {
      const result = handler(msg, resolve);
      if (result instanceof Promise) {
        result.catch((err) => resolve({ error: String(err) }));
      }
    });
  }

  setA2UIManager(manager: unknown): void {
    this.a2uiManager = manager;
  }

  setSchemaResolver(resolver: unknown): void {
    this.schemaResolver = resolver;
  }

  onSpaConnect(listener: (ws: unknown) => void): void {
    this.spaConnectListeners.push(listener as (ws: WebSocket) => void);
  }

  getSpaSession(ws: unknown): string {
    // Find which session this WebSocket belongs to
    for (const [sessionId, clients] of this.clients) {
      if (clients.has(ws as WebSocket)) {
        return sessionId;
      }
    }
    return "main";
  }

  /** Update the active (fallback) session. */
  setActiveSession(session: string): void {
    this.activeSession = session;
  }

  /** The active (fallback) session, used when a message specifies none. */
  getActiveSession(): string {
    return this.activeSession;
  }

  sendToSpa(ws: unknown, message: unknown): void {
    const socket = ws as WebSocket;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
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

    this.broadcastSpaSession(sessionId, { type: "requestSnapshot" });

    return new Promise((resolve, _reject) => {
      const timeout = setTimeout(() => {
        this.pendingSnapshots.delete(sessionId);
        resolve(""); // Return empty string on timeout
      }, 15000);

      this.pendingSnapshots.set(sessionId, { resolve, reject: _reject, timeout });
    });
  }

  close(): void {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    for (const pending of this.pendingSnapshots.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingSnapshots.clear();
  }
}
