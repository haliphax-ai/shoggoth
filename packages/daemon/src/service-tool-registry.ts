/**
 * Service Tool Registry - Dynamic tool registration from service manifests
 *
 * Manages the lifecycle of tools exposed by external services, providing
 * namespaced registration, lookup, and invocation.
 */

import type { ServiceManifest, ServiceToolDeclaration } from "@shoggoth/shared";
import type { ServiceRegistry } from "./service-registry";
import type { ServiceToolDispatcher } from "./service-tool-dispatcher";

interface RegisteredTool {
  serviceId: string;
  toolDecl: ServiceToolDeclaration;
}

/**
 * ServiceToolRegistry handles dynamic registration and invocation of tools
 * declared in service manifests. Tools are namespaced as `{serviceId}.{toolName}`.
 */
export class ServiceToolRegistry {
  private toolMap = new Map<string, RegisteredTool>();
  private serviceRegistry: ServiceRegistry;
  private dispatcher: ServiceToolDispatcher;

  constructor(serviceRegistry: ServiceRegistry, dispatcher: ServiceToolDispatcher) {
    this.serviceRegistry = serviceRegistry;
    this.dispatcher = dispatcher;
  }

  /**
   * Register all tools from a service manifest under the given service ID.
   * Tools are namespaced as `{serviceId}.{tool.name}`.
   *
   * @param serviceId - The service ID to namespace tools under
   * @param manifest - The service manifest containing tool declarations
   * @returns Array of qualified tool names that were registered
   */
  registerServiceTools(serviceId: string, manifest: ServiceManifest): string[] {
    const tools = manifest.tools ?? [];
    const registered: string[] = [];

    for (const tool of tools) {
      const qualifiedName = `${serviceId}.${tool.name}`;
      this.toolMap.set(qualifiedName, { serviceId, toolDecl: tool });
      registered.push(qualifiedName);
    }

    // Update the ServiceEntry's registeredTools array
    const entry = this.serviceRegistry.get(serviceId);
    if (entry) {
      entry.registeredTools = registered;
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
   * Get the tool declaration for a qualified tool name.
   *
   * @param qualifiedName - The fully qualified tool name (e.g., "myservice.users.get")
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
    for (const [qualifiedName, { serviceId, toolDecl }] of this.toolMap) {
      result.push({ qualifiedName, serviceId, description: toolDecl.description });
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
   * @throws Error if the tool or service is not found
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

    const serviceEntry = this.serviceRegistry.get(registered.serviceId);
    if (!serviceEntry) {
      throw new Error(`Service not found: ${registered.serviceId}`);
    }

    return this.dispatcher.dispatch(registered.toolDecl, args, {
      agentId: ctx.agentId,
      sessionUrn: ctx.sessionUrn,
      serviceEntry,
    });
  }
}
