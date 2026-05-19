/**
 * Service Tool Registry - Dynamic tool registration from plugin services
 *
 * Manages the lifecycle of tools exposed by plugin services, providing
 * namespaced registration, lookup, and direct invocation.
 */

import type { ServiceRegistry, ServiceManifest, ServiceToolDeclaration } from "./service-registry";
import type { ServiceToolDispatcher } from "./service-tool-dispatcher";
import type { DirectServiceTool, DirectToolContext } from "@shoggoth/plugins";

/**
 * Registered tool - direct (in-process handler) from a plugin service.
 */
export interface RegisteredDirectTool {
  kind: "direct";
  serviceId: string;
  tool: DirectServiceTool;
}

/**
 * Registered tool - HTTP proxy to a managed/external service.
 */
export interface RegisteredHttpTool {
  kind: "http";
  serviceId: string;
  decl: ServiceToolDeclaration;
}

/**
 * Union type for all registered service tools.
 */
export type RegisteredServiceTool = RegisteredDirectTool | RegisteredHttpTool;

/**
 * Options for creating a ServiceToolRegistry.
 */

/**
 * ServiceToolRegistry handles dynamic registration and invocation of tools
 * provided by plugin services via direct handler functions or HTTP proxy.
 */
export class ServiceToolRegistry {
  private toolMap = new Map<string, RegisteredServiceTool>();
  private serviceRegistry: ServiceRegistry;
  private dispatcher?: ServiceToolDispatcher;
  private eventHandlerAttached = false;

  constructor(serviceRegistry: ServiceRegistry, dispatcher?: ServiceToolDispatcher) {
    this.serviceRegistry = serviceRegistry;
    this.dispatcher = dispatcher;

    // Attach event listener for service deregistration
    this.attachEventHandlers();
  }

  /**
   * Attach event handlers to the service registry to automatically
   * deregister tools when a service is removed.
   */
  private attachEventHandlers(): void {
    if (this.eventHandlerAttached) return;

    this.serviceRegistry.on("deregistered", (id: string) => {
      this.deregisterServiceTools(id);
    });

    this.eventHandlerAttached = true;
  }

  /**
   * Register tools from a service manifest (HTTP proxy dispatch).
   * Each tool in the manifest becomes an HTTP proxy handler.
   *
   * @param serviceId - The service ID to associate with these tools
   * @param manifest - The service manifest containing tool declarations
   * @returns Array of tool names that were registered
   */
  registerServiceTools(serviceId: string, manifest: ServiceManifest): string[] {
    const registered: string[] = [];
    const tools = manifest.tools ?? [];

    for (const decl of tools) {
      this.toolMap.set(decl.name, { kind: "http", serviceId, decl });
      registered.push(decl.name);
    }

    // Update the ServiceEntry's registeredTools array
    const entry = this.serviceRegistry.get(serviceId);
    if (entry) {
      entry.registeredTools = [...(entry.registeredTools ?? []), ...registered];
    }

    return registered;
  }

  /**
   * Register tools with direct handler functions under the given service ID.
   * Tool names are used as-is (the plugin provides fully qualified names like "canvas.push").
   *
   * @param serviceId - The service ID to associate with these tools
   * @param tools - Array of direct service tools with handler functions
   * @returns Array of tool names that were registered
   */
  registerDirectTools(serviceId: string, tools: DirectServiceTool[]): string[] {
    const registered: string[] = [];

    for (const tool of tools) {
      this.toolMap.set(tool.name, { kind: "direct", serviceId, tool });
      registered.push(tool.name);
    }

    // Update the ServiceEntry's registeredTools array
    const entry = this.serviceRegistry.get(serviceId);
    if (entry) {
      entry.registeredTools = [...(entry.registeredTools ?? []), ...registered];
    }

    return registered;
  }

  /**
   * Deregister all tools for a given service.
   *
   * @param serviceId - The service ID whose tools should be removed
   */
  deregisterServiceTools(serviceId: string): void {
    for (const [qualifiedName, registered] of this.toolMap) {
      if (registered.serviceId === serviceId) {
        this.toolMap.delete(qualifiedName);
      }
    }

    // Clear the ServiceEntry's registeredTools array
    const entry = this.serviceRegistry.get(serviceId);
    if (entry) {
      entry.registeredTools = [];
    }
  }

  /**
   * Get the registered tool info for a qualified tool name.
   *
   * @param toolName - The fully qualified tool name (e.g., "demo.set_message")
   * @returns The registered tool info or undefined if not found
   */
  get(toolName: string): RegisteredServiceTool | undefined {
    return this.toolMap.get(toolName);
  }

  /**
   * List all registered tools with their metadata.
   *
   * @returns Array of tool summaries
   */
  listTools(): Array<{ qualifiedName: string; serviceId: string; description: string }> {
    const result: Array<{ qualifiedName: string; serviceId: string; description: string }> = [];
    for (const [qualifiedName, registered] of this.toolMap) {
      if (registered.kind === "direct") {
        result.push({
          qualifiedName,
          serviceId: registered.serviceId,
          description: registered.tool.description,
        });
      } else {
        result.push({
          qualifiedName,
          serviceId: registered.serviceId,
          description: registered.decl.description,
        });
      }
    }
    return result;
  }

  /**
   * Invoke a registered tool by its qualified name.
   * Routes to direct handler or HTTP proxy.
   *
   * @param toolName - The fully qualified tool name
   * @param args - Arguments to pass to the tool
   * @param ctx - Context containing agent and session information
   * @returns The result from the service as a JSON string
   * @throws Error if the tool is not found or dispatcher is not configured for HTTP tools
   */
  async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: { agentId: string; sessionUrn: string },
  ): Promise<{ resultJson: string }> {
    const registered = this.toolMap.get(toolName);
    if (!registered) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (registered.kind === "direct") {
      const toolContext: DirectToolContext = {
        agentId: ctx.agentId,
        sessionUrn: ctx.sessionUrn,
      };
      return registered.tool.handler(args, toolContext);
    }

    // HTTP proxy tools require a dispatcher
    if (!this.dispatcher) {
      throw new Error("HTTP tool dispatcher not configured");
    }

    return this.dispatcher.dispatch(registered.serviceId, registered.decl, args, ctx);
  }
}
