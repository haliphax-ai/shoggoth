import type { JsonSchemaLike } from "./json-schema";

/** One MCP tool entry as advertised to clients (capabilities / tools/list). */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** OpenAI/MCP-style JSON Schema for arguments; clients must not omit fields silently when this is set. */
  readonly inputSchema: JsonSchemaLike;
}
