/**
 * Service Tool Dispatcher - HTTP proxy for managed/external service tools
 *
 * Dispatches tool calls to managed services via HTTP, building requests
 * based on tool declarations in the service manifest.
 */

import type { ServiceRegistry, ServiceToolDeclaration } from "./service-registry";
import type { TokenMinter } from "./service-auth.js";

/**
 * Context for tool invocation.
 */
export interface ToolInvokeContext {
  /** The agent ID making the call. */
  agentId: string;
  /** The session URN. */
  sessionUrn: string;
}

/**
 * HTTP proxy dispatcher for managed/external service tools.
 * Builds and sends HTTP requests based on tool declarations.
 */
export class ServiceToolDispatcher {
  private serviceRegistry: ServiceRegistry;
  private tokenMinter?: TokenMinter;
  private placeholderToken = "shoggoth-placeholder";

  constructor(serviceRegistry: ServiceRegistry, tokenMinter?: TokenMinter) {
    this.serviceRegistry = serviceRegistry;
    this.tokenMinter = tokenMinter;
  }

  /** Set or replace the token minter (for late wiring after key store init). */
  setTokenMinter(minter: TokenMinter): void {
    this.tokenMinter = minter;
  }

  /**
   * Execute HTTP request and handle response.
   */
  private async executeRequest(
    url: string,
    requestInit: RequestInit,
  ): Promise<{ resultJson: string }> {
    const response = await fetch(url, requestInit);

    if (!response.ok) {
      // Handle non-2xx responses gracefully
      const errorText = await response.text();
      return {
        resultJson: JSON.stringify({
          error: true,
          status: response.status,
          statusText: response.statusText,
          message: errorText,
        }),
      };
    }

    const responseText = await response.text();
    return { resultJson: responseText };
  }

  /**
   * Dispatch a tool call to a managed/external service via HTTP.
   * Resolves service URL from registry, injects auth header,
   * sends request, returns response body.
   *
   * @param serviceId - The service ID to dispatch to
   * @param decl - The tool declaration
   * @param args - Arguments to pass to the tool
   * @param ctx - Invocation context
   * @returns The result as a JSON string
   */
  async dispatch(
    serviceId: string,
    decl: ServiceToolDeclaration,
    args: Record<string, unknown>,
    ctx: ToolInvokeContext,
  ): Promise<{ resultJson: string }> {
    const entry = this.serviceRegistry.get(serviceId);

    if (!entry) {
      throw new Error(`Service not found: ${serviceId}`);
    }

    if (!entry.healthy) {
      throw new Error(`Service ${serviceId} is unhealthy`);
    }

    if (!entry.url) {
      throw new Error(`Service ${serviceId} has no URL`);
    }

    // Determine auth token
    let token = this.placeholderToken;
    if (this.tokenMinter) {
      try {
        token = await this.tokenMinter.mint(ctx.agentId, serviceId, ctx.sessionUrn);
      } catch {
        console.warn(
          `TokenMinter: failed to mint token for service ${serviceId}, falling back to placeholder`,
        );
      }
    }

    const dispatch = decl.dispatch ?? "body";
    let path = decl.path;
    const method = (decl.method ?? "POST").toUpperCase();
    const canHaveBody = method !== "GET" && method !== "HEAD";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (canHaveBody) {
      headers["Content-Type"] = "application/json";
    }

    const requestInit: RequestInit = { method, headers };

    try {
      if (dispatch === "body") {
        if (canHaveBody) {
          requestInit.body = JSON.stringify(args);
        } else {
          // GET/HEAD cannot have body — fall back to query params
          const url = new URL(path, entry.url);
          for (const [key, value] of Object.entries(args)) {
            url.searchParams.set(key, String(value));
          }
          return await this.executeRequest(url.toString(), requestInit);
        }
        const url = new URL(path, entry.url);
        return await this.executeRequest(url.toString(), requestInit);
      } else if (dispatch === "query") {
        const url = new URL(path, entry.url);
        for (const [key, value] of Object.entries(args)) {
          url.searchParams.set(key, String(value));
        }
        return await this.executeRequest(url.toString(), requestInit);
      } else if (dispatch === "path") {
        for (const [key, value] of Object.entries(args)) {
          path = path.split(`{${key}}`).join(String(value));
        }
        const url = new URL(path, entry.url);
        return await this.executeRequest(url.toString(), requestInit);
      }

      // Fallback
      const url = new URL(path, entry.url);
      return await this.executeRequest(url.toString(), requestInit);
    } catch (error) {
      throw new Error(
        `Failed to dispatch tool to ${serviceId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
