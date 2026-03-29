export {
  mintAgentCredentialRaw,
  hashAgentToken,
  timingSafeEqualRawToHash,
  MemoryAgentTokenStore,
  agentPrincipalFromToken,
  SHOGGOTH_AGENT_TOKEN_ENV,
  type AgentTokenRecord,
  type AgentTokenStore,
} from "./agent-token";
export {
  parseOperatorMapJson,
  operatorMapFromFileJson,
  loadOperatorMapFromPath,
  operatorPrincipalFromPeer,
  chainOperatorMaps,
  type OperatorEntry,
  type OperatorMapFile,
  type OperatorMap,
} from "./operator-map";
export { validateOperatorToken, hashOperatorTokenOpaque } from "./operator-token";
export {
  readPeerCredFromSocket,
  unixSocketFdForTests,
  ERR_PEERCRED_NOT_IMPLEMENTED,
  ERR_PEERCRED_NO_FD,
} from "./peercred";
export type {
  AuthSource,
  PeerCredentials,
  OperatorPrincipal,
  AgentPrincipal,
  SystemPrincipal,
  AuthenticatedPrincipal,
} from "./principal";
export {
  resolveAuthenticatedPrincipal,
  type ResolveAuthContext,
} from "./resolve-auth";
export {
  WIRE_VERSION,
  parseRequestLine,
  serializeResponse,
  parseResponseLine,
  WireParseError,
  type WireRequest,
  type WireResponse,
  type WireErrorBody,
} from "./wire";
export type {
  WireAuth,
  WireAuthOperatorPeercred,
  WireAuthOperatorToken,
  WireAuthAgent,
} from "./wire-auth";
