/**
 * Shared definitions for the demo service.
 *
 * Single source of truth for the default message, HTML escaping, and tool
 * metadata used by both the plugin entrypoint and the standalone server.
 */

/** Default in-memory message displayed by the demo service. */
export const DEFAULT_MESSAGE = "Hello from the Shoggoth demo service!";

/** Escape a string for safe interpolation into HTML text content. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Metadata for a demo tool (name, description, and parameter JSON Schema). */
export interface DemoToolDefinition {
  /** Tool name as exposed to agents. */
  readonly name: string;
  /** Human-readable description for the tool descriptor. */
  readonly description: string;
  /** JSON Schema for the tool's parameters. */
  readonly parameters: Record<string, unknown>;
}

/** Tool metadata shared by plugin tool registration and the service manifest. */
export const DEMO_TOOLS: readonly DemoToolDefinition[] = [
  {
    name: "demo.set_message",
    description:
      "Set the message displayed by the demo web service. Visit the service URL to see the current message.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The new message to display",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "demo.get_message",
    description: "Get the current message displayed by the demo web service.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
