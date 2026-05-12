/**
 * Service Tool Registry - Dynamic tool registration from plugin services
 *
 * Manages the lifecycle of tools exposed by plugin services, providing
 * namespaced registration, lookup, and direct invocation.
 */

import type { ServiceRegistry } from "./service-registry";
import type { DirectServiceTool, DirectToolContext } from "@shoggoth/plugins";

/**
 * Registered tool - direct (in-process handler) from a plugin service.
 */
interface RegisteredTool {
  kind: "direct";
  serviceId: string;
  tool: DirectServiceTool;
}

/**
 * ServiceToolRegistry handles dynamic registration and invocation of tools
 * provided by plugin services via direct handler functions.
 */
export class ServiceToolRegistry {
  private toolMap = new Map<string, RegisteredTool>();
  private serviceRegistry: ServiceRegistry;

  constructor(serviceRegistry: ServiceRegistry) {
    this.serviceRegistry = serviceRegistry;
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
   * @param qualifiedName - The fully qualified tool name (e.g., "demo.set_message")
   * @returns The registered tool info or undefined if not found
   */
  getToolDeclaration(qualifiedName: string): RegisteredTool | undefined {
    return this.toolMap.get(qualifiedName);
  }

  /**
   * List all registered tools with their metadata.
   *
   * @returns Array of tool summaries
   */
  listTools(): Array<{ qualifiedName: string; serviceId: string; description: string }> {
    const result: Array<{ qualifiedName: string; serviceId: string; description: string }> = [];
    for (const [qualifiedName, registered] of this.toolMap) {
      result.push({ qualifiedName, serviceId: registered.serviceId, description: registered.tool.description });
    }
    return result;
  }

  /**
   * Invoke a registered tool by its qualified name.
   *
   * @param qualifiedName - The fully qualified tool name
   * @param args - Arguments to pass to the tool
   * @param ctx - Context containing agent and session information
   * @returns The result from the service as a JSON string
   * @throws Error if the tool is not found
   */
  async invokeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
    ctx: { agentId: string; sessionUrn: string },
  ): Promise<{ resultJson: string }> {
    const registered = this.toolMap.get(qualifiedName);
    if (!registered) {
      throw new Error(`Unknown tool: ${qualifiedName}`);
    }

    const toolContext: DirectToolContext = {
      agentId: ctx.agentId,
      sessionUrn: ctx.sessionUrn,
    };
    return registered.tool.handler(args, toolContext);
  }
}
