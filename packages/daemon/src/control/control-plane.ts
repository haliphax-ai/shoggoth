import {
  ERR_PEERCRED_NOT_IMPLEMENTED,
  MemoryAgentTokenStore,
  chainOperatorMaps,
  loadOperatorMapFromPath,
  operatorMapFromFileJson,
  parseRequestLine,
  readPeerCredFromSocket,
  resolveAuthenticatedPrincipal,
  serializeResponse,
  WireParseError,
  WIRE_VERSION,
  type AgentTokenStore,
  type AuthenticatedPrincipal,
  type OperatorMap,
  type PeerCredentials,
  type WireRequest,
  type WireResponse,
} from "@shoggoth/authn";
import type { ShoggothConfig } from "@shoggoth/shared";
import type Database from "better-sqlite3";
import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { appendAuditRow, type AppendAuditRowInput } from "../audit/append-audit";
import { readOperatorTokenSecret } from "../auth/read-operator-secret";
import { createSqliteAgentTokenStore } from "../auth/sqlite-agent-tokens";
import { createSqliteOperatorMap } from "../auth/sqlite-operator-map";
import type { HealthSnapshot } from "../health";
import type { Logger } from "../logging";
import { auditSourceForPrincipal, principalAuditFields } from "../policy/audit-source";
import { createPolicyEngine, isDefinedControlOp, type PolicyEngine } from "../policy/engine";
import type { ShutdownCoordinator } from "../shutdown";
import { createAcpxProcessSupervisor, type AcpxSpawnFn } from "../acpx/acpx-process-supervisor";
import { createSqliteAcpxBindingStore } from "../acpx/sqlite-acpx-bindings";
import { createSessionManager } from "../sessions/session-manager";
import { createSessionStore } from "../sessions/session-store";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import {
  handleIntegrationControlOp,
  IntegrationOpError,
  type IntegrationOpsContext,
} from "./integration-ops";
import { dispatchMcpHttpCancelRequest } from "../mcp/mcp-http-cancel-registry";

export type ReadPeerCredFn = (socket: Socket) => PeerCredentials;

export type ControlPlaneOptions = {
  config: ShoggothConfig;
  /**
   * When set, used for control-socket authz instead of building a fresh engine from
   * `config.policy` (supports in-process policy updates via {@link createDelegatingPolicyEngine}).
   */
  policyEngine?: PolicyEngine;
  logger: Logger;
  shutdown: ShutdownCoordinator;
  getHealth: () => Promise<HealthSnapshot>;
  version: string;
  /** When set, `agent_tokens` and `operator_uid_map` are backed by SQLite. */
  stateDb?: Database.Database;
  /**
   * Defaults to `readPeerCredFromSocket` (Linux N-API SO_PEERCRED). Override for tests or
   * non-Linux hosts where the native stub rejects peercred auth.
   */
  readPeerCred?: ReadPeerCredFn;
  /** When true (default), register a shutdown drain that closes the listener. */
  registerShutdownDrain?: boolean;
  /** Test hook: override `child_process.spawn` for `acpx_agent_start`. */
  acpxSpawn?: AcpxSpawnFn;
  /** When set with `stateDb`, exposes `hitl_pending_*` control ops. */
  hitlPending?: PendingActionsStore;
  /** Test hook: override `mcp_http_cancel_request` routing (default: Discord platform cancel registry). */
  cancelMcpHttpRequest?: IntegrationOpsContext["cancelMcpHttpRequest"];
};

export type ControlPlaneHandle = {
  socketPath: string;
  close: () => Promise<void>;
};

class ControlOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function layeredOperatorMapHasEntries(
  om: ShoggothConfig["operatorMap"],
): om is NonNullable<ShoggothConfig["operatorMap"]> {
  if (!om) return false;
  if (om.defaultOperator) return true;
  return Boolean(om.byUid && Object.keys(om.byUid).length > 0);
}

function buildOperatorMap(config: ShoggothConfig, stateDb?: Database.Database): OperatorMap {
  const layers: OperatorMap[] = [];
  if (stateDb) layers.push(createSqliteOperatorMap(stateDb));
  if (layeredOperatorMapHasEntries(config.operatorMap)) {
    layers.push(
      operatorMapFromFileJson({
        defaultOperator: config.operatorMap.defaultOperator,
        byUid: config.operatorMap.byUid,
      }),
    );
  }
  if (config.operatorMapPath) layers.push(loadOperatorMapFromPath(config.operatorMapPath));
  layers.push(
    operatorMapFromFileJson({
      defaultOperator: {
        operatorId: "local-operator",
        roles: ["admin"],
      },
    }),
  );
  return chainOperatorMaps(layers);
}

function recordControlPlaneAudit(
  db: Database.Database | undefined,
  logger: Logger,
  row: AppendAuditRowInput,
): void {
  if (!db) return;
  try {
    appendAuditRow(db, row);
  } catch (e) {
    logger.warn("audit append failed", { err: String(e) });
  }
}

async function dispatchOp(
  req: WireRequest,
  ctx: { getHealth: () => Promise<HealthSnapshot>; version: string },
  principal: AuthenticatedPrincipal,
  integrationCtx: IntegrationOpsContext,
): Promise<unknown> {
  const integration = handleIntegrationControlOp(req, principal, integrationCtx);
  if (integration !== undefined) return integration;

  if (principal.kind === "agent") {
    if (req.op === "agent_ping") {
      return { pong: true, session_id: principal.sessionId };
    }
    throw new ControlOpError("ERR_UNKNOWN_OP", `unknown op: ${req.op}`);
  }

  switch (req.op) {
    case "ping":
      return { pong: true };
    case "version":
      return { version: ctx.version };
    case "health":
      return await ctx.getHealth();
    default:
      throw new ControlOpError("ERR_UNKNOWN_OP", `unknown op: ${req.op}`);
  }
}

async function handleOneLine(
  line: string,
  socket: Socket,
  deps: {
    readPeer: ReadPeerCredFn;
    operatorMap: OperatorMap;
    operatorTokenSecret: string | undefined;
    agentStore: AgentTokenStore;
    getHealth: () => Promise<HealthSnapshot>;
    version: string;
    engine: PolicyEngine;
    stateDb: Database.Database | undefined;
    integration: Pick<
      IntegrationOpsContext,
      | "config"
      | "acpxStore"
      | "sessions"
      | "sessionManager"
      | "acpxSupervisor"
      | "hitlPending"
      | "cancelMcpHttpRequest"
    >;
    logger: Logger;
  },
): Promise<WireResponse> {
  let req: WireRequest;
  try {
    req = parseRequestLine(line);
  } catch (e) {
    if (e instanceof WireParseError) {
      return {
        v: WIRE_VERSION,
        id: "",
        ok: false,
        error: { code: "ERR_INVALID_REQUEST", message: e.message },
      };
    }
    throw e;
  }

  try {
    const peer = deps.readPeer(socket);
    const principal = resolveAuthenticatedPrincipal(req.auth, {
      peer,
      operatorMap: deps.operatorMap,
      operatorTokenSecret: deps.operatorTokenSecret,
      agentTokenStore: deps.agentStore,
    });
    if (!principal) {
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: { code: "ERR_AUTHN_FAILED", message: "authentication failed" },
      };
    }

    const auditBaseFields = (): Omit<AppendAuditRowInput, "action" | "resource" | "outcome" | "argsRedactedJson"> => {
      const source = auditSourceForPrincipal(principal);
      const pf = principalAuditFields(principal);
      return {
        source,
        principalKind: pf.principalKind,
        principalId: pf.principalId,
        sessionId: pf.sessionId ?? null,
        agentId: pf.agentId ?? null,
        peerUid: pf.peerUid ?? null,
        peerGid: pf.peerGid ?? null,
        peerPid: pf.peerPid ?? null,
        correlationId: req.id,
      };
    };

    if (!isDefinedControlOp(req.op)) {
      recordControlPlaneAudit(deps.stateDb, deps.logger, {
        ...auditBaseFields(),
        action: "authz.control",
        resource: req.op,
        outcome: "unknown_op",
      });
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: { code: "ERR_UNKNOWN_OP", message: `unknown op: ${req.op}` },
      };
    }

    const authz = deps.engine.check({
      principal,
      action: "control.invoke",
      resource: req.op,
    });
    if (!authz.allow) {
      recordControlPlaneAudit(deps.stateDb, deps.logger, {
        ...auditBaseFields(),
        action: "authz.control",
        resource: req.op,
        outcome: "denied",
        argsRedactedJson: JSON.stringify({ reason: authz.reason }),
      });
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: { code: "ERR_FORBIDDEN", message: authz.reason },
      };
    }

    const integrationCtx: IntegrationOpsContext = {
      config: deps.integration.config,
      acpxStore: deps.integration.acpxStore,
      sessions: deps.integration.sessions,
      sessionManager: deps.integration.sessionManager,
      acpxSupervisor: deps.integration.acpxSupervisor,
      hitlPending: deps.integration.hitlPending,
      cancelMcpHttpRequest: deps.integration.cancelMcpHttpRequest,
      recordIntegrationAudit: (extras) =>
        recordControlPlaneAudit(deps.stateDb, deps.logger, {
          ...auditBaseFields(),
          ...extras,
        }),
    };

    const result = await dispatchOp(
      req,
      {
        getHealth: deps.getHealth,
        version: deps.version,
      },
      principal,
      integrationCtx,
    );
    recordControlPlaneAudit(deps.stateDb, deps.logger, {
      ...auditBaseFields(),
      action: "authz.control",
      resource: req.op,
      outcome: "allowed",
    });
    return { v: WIRE_VERSION, id: req.id, ok: true, result };
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === ERR_PEERCRED_NOT_IMPLEMENTED) {
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: {
          code: ERR_PEERCRED_NOT_IMPLEMENTED,
          message: e.message,
          details: {
            followUp:
              "Wire Linux SO_PEERCRED via getsockopt (native addon); see packages/authn/README.md",
          },
        },
      };
    }
    if (e instanceof ControlOpError) {
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: { code: e.code, message: e.message },
      };
    }
    if (e instanceof IntegrationOpError) {
      return {
        v: WIRE_VERSION,
        id: req.id,
        ok: false,
        error: { code: e.code, message: e.message },
      };
    }
    throw e;
  }
}

/**
 * Control plane: Unix socket, JSONL framing, minimal op router.
 * Socket mode defaults to `0o600` (operator UID only). Set `controlSocketGid` + mode `0o660` for group access.
 */
export async function startControlPlane(opts: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  const {
    config,
    policyEngine: policyEngineOpt,
    logger,
    shutdown,
    getHealth,
    version,
    stateDb,
    readPeerCred,
    registerShutdownDrain = true,
    acpxSpawn,
    hitlPending: hitlPendingOpt,
    cancelMcpHttpRequest: cancelMcpHttpRequestOpt,
  } = opts;

  const readPeer = readPeerCred ?? readPeerCredFromSocket;
  const operatorMap = buildOperatorMap(config, stateDb);
  const acpxStore = stateDb ? createSqliteAcpxBindingStore(stateDb) : undefined;
  const agentStore = stateDb
    ? createSqliteAgentTokenStore(stateDb)
    : new MemoryAgentTokenStore();
  const operatorTokenSecret = readOperatorTokenSecret(config);
  const engine = policyEngineOpt ?? createPolicyEngine(config.policy);
  const socketPath = config.socketPath;
  const mode = config.controlSocketMode ?? 0o600;

  let sessions: ReturnType<typeof createSessionStore> | undefined;
  let sessionManager: ReturnType<typeof createSessionManager> | undefined;
  let acpxSupervisor: ReturnType<typeof createAcpxProcessSupervisor> | undefined;
  if (stateDb) {
    sessions = createSessionStore(stateDb);
    sessionManager = createSessionManager({
      db: stateDb,
      sessions,
      agentTokens: agentStore,
    });
    acpxSupervisor = createAcpxProcessSupervisor({
      logger: logger.child({ subsystem: "acpx" }),
      spawn: acpxSpawn,
    });
    shutdown.registerDrain("acpx-processes", () => {
      acpxSupervisor?.killAll();
    });
  }

  const integrationBundle: Pick<
    IntegrationOpsContext,
    | "config"
    | "acpxStore"
    | "sessions"
    | "sessionManager"
    | "acpxSupervisor"
    | "hitlPending"
    | "cancelMcpHttpRequest"
  > = {
    config,
    acpxStore,
    sessions,
    sessionManager,
    acpxSupervisor,
    hitlPending: hitlPendingOpt,
    cancelMcpHttpRequest: cancelMcpHttpRequestOpt ?? dispatchMcpHttpCancelRequest,
  };

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    await unlink(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const prevUmask = process.umask(0o077);

  const server: Server = createServer((socket) => {
    let buf = "";
    let chain = Promise.resolve();
    const flushLines = () => {
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const captured = line;
        chain = chain
          .then(() =>
            handleOneLine(captured, socket, {
              readPeer,
              operatorMap,
              operatorTokenSecret,
              agentStore,
              getHealth,
              version,
              engine,
              stateDb,
              integration: integrationBundle,
              logger,
            }),
          )
          .then((res) => {
            socket.write(serializeResponse(res));
          })
          .catch((err: unknown) => {
            logger.error("control plane request failed", { err: String(err) });
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          });
      }
    };

    socket.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      flushLines();
    });
    socket.on("error", (err) => {
      logger.debug("control client socket error", { err: String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.umask(prevUmask);

  await chmod(socketPath, mode);
  if (config.controlSocketUid !== undefined && config.controlSocketGid !== undefined) {
    await chown(socketPath, config.controlSocketUid, config.controlSocketGid);
  }

  logger.info("control plane listening", { socketPath, mode });

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(err);
          return;
        }
        void unlink(socketPath)
          .catch(() => {
            /* ignore */
          })
          .finally(() => resolve());
      });
    });

  if (registerShutdownDrain) {
    shutdown.registerDrain("control-plane", close);
  }

  return { socketPath, close };
}
