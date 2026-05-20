import { EventEmitter } from "events";
import net from "node:net";
import http from "node:http";

export interface ExternalServiceDeclaration {
  id: string;
  label?: string;
  host: string;
  port: number;
  protocol: "http" | "ws" | "http+ws";
  basePath?: string;
  capabilities?: string[];
  expose?: "gateway" | "direct" | "both";
  manifestPath?: string;
  health:
    | { kind: "tcp"; port?: number; timeoutMs?: number }
    | { kind: "http"; url: string; expectedStatus?: number; timeoutMs?: number };
  healthIntervalMs?: number;
  unhealthyThreshold?: number;
}

interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
}

interface ServiceState {
  declaration: ExternalServiceDeclaration;
  intervalTimer: NodeJS.Timeout | null;
  consecutiveFailures: number;
  currentState: "healthy" | "unhealthy" | "unknown";
  currentIntervalMs: number;
}

const DEFAULT_HEALTH_INTERVAL_MS = 30000;
const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const MAX_BACKOFF_MS = 300000;

export class TcpHealthChecker {
  async check(host: string, port: number, timeoutMs: number = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      const timer = setTimeout(() => settle(false), timeoutMs);

      const socket = net.createConnection({ host, port }, () => {
        settle(true);
      });

      socket.on("error", () => settle(false));
    });
  }
}

export class HttpHealthChecker {
  async check(
    url: string,
    expectedStatus: number = 200,
    timeoutMs: number = 5000,
  ): Promise<{ success: boolean; error?: Error }> {
    return new Promise((resolve) => {
      const request = http.get(url, (response) => {
        const success = response.statusCode === expectedStatus;
        // Consume the response body to free up resources
        response.on("data", () => {});
        response.on("end", () => {
          if (success) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: new Error(`HTTP ${response.statusCode}`),
            });
          }
        });
      });

      request.on("error", (error) => {
        resolve({ success: false, error });
      });

      request.on("timeout", () => {
        request.destroy();
        resolve({ success: false, error: new Error("Request timeout") });
      });

      request.setTimeout(timeoutMs);
    });
  }
}

export class ExternalServiceHealthPoller extends EventEmitter {
  private services = new Map<string, ServiceState>();
  private tcpHealthChecker: TcpHealthChecker;
  private httpHealthChecker: HttpHealthChecker;

  constructor(private logger: Logger) {
    super();
    this.tcpHealthChecker = new TcpHealthChecker();
    this.httpHealthChecker = new HttpHealthChecker();
  }

  add(declaration: ExternalServiceDeclaration): void {
    // If already exists, remove first
    if (this.services.has(declaration.id)) {
      this.remove(declaration.id);
    }

    const healthIntervalMs = declaration.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    const unhealthyThreshold = declaration.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;

    const state: ServiceState = {
      declaration,
      intervalTimer: null,
      consecutiveFailures: 0,
      currentState: "unknown",
      currentIntervalMs: healthIntervalMs,
    };

    this.services.set(declaration.id, state);

    // Run the first health check immediately (don't wait for the first interval tick)
    this.runHealthCheck(declaration.id).catch((err) => {
      this.logger.warn(`Initial health check failed for ${declaration.id}`, err);
    });

    // Schedule subsequent checks
    state.intervalTimer = setInterval(() => this.runHealthCheck(declaration.id), healthIntervalMs);

    this.logger.debug(`Added health poller for service ${declaration.id}`, {
      id: declaration.id,
      intervalMs: healthIntervalMs,
      unhealthyThreshold,
    });
  }

  remove(serviceId: string): void {
    const state = this.services.get(serviceId);
    if (state) {
      if (state.intervalTimer) {
        clearInterval(state.intervalTimer);
        state.intervalTimer = null;
      }
      this.services.delete(serviceId);
      this.logger.debug(`Removed health poller for service ${serviceId}`);
    }
  }

  update(declaration: ExternalServiceDeclaration): void {
    // Remove and re-add with new config
    this.remove(declaration.id);
    this.add(declaration);
  }

  stopAll(): void {
    for (const [serviceId] of this.services) {
      this.remove(serviceId);
    }
    this.logger.debug("Stopped all health pollers");
  }

  getState(serviceId: string): "healthy" | "unhealthy" | "unknown" {
    const state = this.services.get(serviceId);
    return state?.currentState ?? "unknown";
  }

  getTrackedIds(): string[] {
    return Array.from(this.services.keys());
  }

  private async runHealthCheck(serviceId: string): Promise<void> {
    const state = this.services.get(serviceId);
    if (!state) return;

    const { declaration } = state;
    let isHealthy = false;
    let error: Error | undefined;

    try {
      if (declaration.health.kind === "tcp") {
        const timeoutMs = declaration.health.timeoutMs ?? 5000;
        const port = declaration.health.port ?? declaration.port;
        isHealthy = await this.tcpHealthChecker.check(declaration.host, port, timeoutMs);
      } else if (declaration.health.kind === "http") {
        const timeoutMs = declaration.health.timeoutMs ?? 5000;
        const expectedStatus = declaration.health.expectedStatus ?? 200;
        const result = await this.httpHealthChecker.check(
          declaration.health.url,
          expectedStatus,
          timeoutMs,
        );
        isHealthy = result.success;
        error = result.error;
      }
    } catch (err) {
      isHealthy = false;
      error = err instanceof Error ? err : new Error(String(err));
    }

    await this.handleHealthResult(serviceId, isHealthy, error);
  }

  private async handleHealthResult(
    serviceId: string,
    isHealthy: boolean,
    error?: Error,
  ): Promise<void> {
    const state = this.services.get(serviceId);
    if (!state) return;

    const { declaration } = state;
    const unhealthyThreshold = declaration.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
    const healthIntervalMs = declaration.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;

    if (isHealthy) {
      // Reset consecutive failures
      state.consecutiveFailures = 0;

      // Check for state transition to healthy
      if (state.currentState !== "healthy") {
        state.currentState = "healthy";
        // Reset interval to configured value on recovery
        state.currentIntervalMs = healthIntervalMs;
        // Reset the interval timer with the original interval
        if (state.intervalTimer) {
          clearInterval(state.intervalTimer);
          state.intervalTimer = setInterval(() => this.runHealthCheck(serviceId), healthIntervalMs);
        }
        this.emit("healthy", serviceId, declaration);
        this.logger.debug(`Service ${serviceId} is now healthy`);
      }
    } else {
      state.consecutiveFailures++;

      // Check if we should emit unhealthy
      if (state.consecutiveFailures >= unhealthyThreshold) {
        // Only emit unhealthy on state transition
        if (state.currentState !== "unhealthy") {
          state.currentState = "unhealthy";
          this.emit("unhealthy", serviceId, error ?? new Error("Health check failed"));
          this.logger.debug(`Service ${serviceId} is now unhealthy`, {
            consecutiveFailures: state.consecutiveFailures,
          });
        }

        // Apply exponential backoff (double the interval), cap at MAX_BACKOFF_MS
        const newInterval = Math.min(state.currentIntervalMs * 2, MAX_BACKOFF_MS);

        // Only update and reset timer if the interval actually changed
        if (newInterval !== state.currentIntervalMs) {
          state.currentIntervalMs = newInterval;
          if (state.intervalTimer) {
            clearInterval(state.intervalTimer);
            state.intervalTimer = setInterval(() => this.runHealthCheck(serviceId), newInterval);
          }
          this.logger.debug(`Backing off health checks for ${serviceId}`, {
            newIntervalMs: newInterval,
          });
        }
      }
    }
  }
}
