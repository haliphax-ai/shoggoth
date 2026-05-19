/**
 * Service Tool Dispatcher - HTTP proxy for managed/external service tools
 *
 * Dispatches tool calls to managed services via HTTP, building requests
 * based on tool declarations in the service manifest.
 */

import type { ServiceRegistry, ServiceToolDeclaration } from "./service-registry";

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
  private placeholderToken = "shoggoth-placeholder";

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
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
   * Resolves service URL from registry, injects placeholder auth header,
   * sends request, returns response body.
   *
   * @param serviceId - The service ID to dispatch to
   * @param decl - The tool declaration
   * @param args - Arguments to pass to the tool
   * @param _ctx - Invocation context (reserved for future use)
   * @returns The result as a JSON string
   */
  async dispatch(
    serviceId: string,
    decl: ServiceToolDeclaration,
    args: Record<string, unknown>,
    _ctx: ToolInvokeContext,
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

    const dispatch = decl.dispatch ?? "body";
    let path = decl.path;

    // Build request options based on dispatch type
    const requestInit: RequestInit = {
      method: decl.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.placeholderToken}`,
      },
    };

    try {
      // Map args based on dispatch type
      if (dispatch === "body") {
        requestInit.body = JSON.stringify(args);
        const url = new URL(path, entry.url);
        return await this.executeRequest(url.toString(), requestInit);
      } else if (dispatch === "query") {
        // For query dispatch, build URL first then add query params
        const url = new URL(path, entry.url);
        for (const [key, value] of Object.entries(args)) {
          url.searchParams.set(key, String(value));
        }
        return await this.executeRequest(url.toString(), requestInit);
      } else if (dispatch === "path") {
        // For path dispatch, replace path params in the path string BEFORE creating URL
        for (const [key, value] of Object.entries(args)) {
          path = path.split(`{${key}}`).join(String(value));
        }
        const url = new URL(path, entry.url);
        return await this.executeRequest(url.toString(), requestInit);
      }

      // Fallback (shouldn't reach here)
      const url = new URL(path, entry.url);
      return await this.executeRequest(url.toString(), requestInit);
    } catch (error) {
      throw new Error(
        `Failed to dispatch tool to ${serviceId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
