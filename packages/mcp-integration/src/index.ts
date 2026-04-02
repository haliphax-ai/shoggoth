export type { JsonSchemaLike } from "./json-schema";
export type { McpToolDescriptor } from "./mcp-tool";
export {
  aggregateMcpCatalogs,
  routeMcpToolInvocation,
  type AggregateMcpCatalogResult,
  type AggregatedTool,
  type McpSourceCatalog,
} from "./aggregate";
export { toMcpToolsListPayload, type McpToolsListPayload } from "./advertise";
export {
  createAcpxBinding,
  findBindingForAcpxWorkspace,
  SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV,
  SHOGGOTH_CONTROL_SOCKET_ENV,
  SHOGGOTH_SESSION_ID_ENV,
  type AcpxWorkspaceBinding,
} from "./acp-bridge";
export { builtinShoggothToolsCatalog, BUILTIN_SOURCE_ID } from "./builtin-shoggoth-tools";
export {
  buildMessageToolDescriptor,
  type MessageToolPlatformSlice,
} from "./message-tool-descriptor";
export {
  connectMcpStdioSession,
  connectMcpTcpSession,
  createMcpJsonRpcSession,
  mcpFetchToolsList,
  mcpInitializeSession,
  mcpInvokeTool,
  mcpToolListEntryToDescriptor,
  mcpToolsToSourceCatalog,
  openMcpStdioClient,
  openMcpTcpClient,
  type McpJsonRpcSession,
  type McpStdioConnectOptions,
  type McpTcpConnectOptions,
  type McpToolListEntry,
} from "./mcp-jsonrpc-transport";
export {
  connectMcpStreamableHttpSession,
  iterateSseDataJson,
  openMcpStreamableHttpClient,
  type McpSseJsonEvent,
  type McpStreamableHttpConnectOptions,
  type McpStreamableHttpServerMessage,
  type McpStreamableHttpSession,
} from "./mcp-streamable-http-transport";
