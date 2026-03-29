export type { JsonSchemaLike } from "./json-schema";
export type { McpToolDescriptor } from "./mcp-tool";
export {
  aggregateMcpCatalogs,
  parseNamespacedMcpTool,
  routeMcpToolInvocation,
  type AggregateMcpCatalogResult,
  type AggregatedTool,
  type McpSourceCatalog,
  type ParsedNamespacedTool,
} from "./aggregate";
export { toMcpToolsListPayload, type McpToolsListPayload } from "./advertise";
export {
  authorizeCanvasAction,
  type CanvasAuthzAction,
  type CanvasAuthzDecision,
  type CanvasAuthzInput,
  type CanvasPrincipalKind,
} from "./canvas-authz";
export {
  createAcpxBinding,
  findBindingForAcpxWorkspace,
  SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV,
  SHOGGOTH_CONTROL_SOCKET_ENV,
  SHOGGOTH_SESSION_ID_ENV,
  type AcpxWorkspaceBinding,
} from "./acp-bridge";
export { builtinShoggothToolsCatalog } from "./builtin-shoggoth-tools";
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
