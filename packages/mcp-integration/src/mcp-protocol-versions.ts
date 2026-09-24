/**
 * Canonical MCP protocol version strings.
 *
 * All defaults and test fixtures should import these instead of
 * hardcoding version strings directly.
 */

/** Default protocol version for MCP stdio / JSON-RPC transport (2024-11-05 spec). */
export const MCP_PROTOCOL_VERSION_STDIO = "2024-11-05";

/** Default protocol version for MCP streamable HTTP transport (2025-11-25 spec). */
export const MCP_PROTOCOL_VERSION_STREAMABLE = "2025-11-25";
