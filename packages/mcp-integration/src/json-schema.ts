/**
 * JSON-Schema-shaped tool descriptors for MCP `tools/list` and client negotiation.
 * Intentionally dependency-free beyond TypeScript types.
 */

export interface JsonSchemaLike {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchemaLike>;
  readonly items?: JsonSchemaLike;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly JsonSchemaLike[];
  readonly minimum?: number;
  readonly maximum?: number;
}
