# Shoggoth — Authentication (`@shoggoth/authn`)

Unix control socket, `SO_PEERCRED`, operator map, optional operator token, agent token mint/validate, JSONL wire.

- **Source:** `src/` (TypeScript) + `src/native/` (N-API peercred addon)
- **Tests:** `test/` (`npm run test`; runs `build:native` first for the `.node` addon)
- **Native:** `npm run build:native` → `node-gyp-build`. **Typecheck:** `npm run typecheck` → `tsc --noEmit`. Runtime never uses emitted JS.

## Integration status

The **`@shoggoth/daemon`** control plane consumes this package (`readPeerCredFromSocket`, JSONL wire, SQLite-backed operator map and agent tokens). This README is the detailed authn contract.

## Unix domain socket

- Path from layered config (e.g. `control.socket.path`, default `/run/shoggoth/control.sock`).
- Create with `umask` / `fs.chmod` so only operator GID or UID can connect (exact mode documented in the operator image layout).
- **Daemon:** listener and auth wiring live in `@shoggoth/daemon` (`control-plane.ts`).

## `SO_PEERCRED`

On Linux, after `accept()` on the Unix socket, call `getsockopt(SOL_SOCKET, SO_PEERCRED, …)` to obtain peer `pid`, `uid`, `gid`.

- **Node.js:** no stable core API; this package ships a tiny **N-API** addon (`shoggoth_peercred.node`) built by `node-gyp-build` on install (`readPeerCred` in `src/native/`).
- **Audit:** store `source=cli_socket`, `peer_uid`, `peer_gid`, `peer_pid` on each request (audit logging consumes these fields).
- **Non-Linux:** stub native throws `ERR_PEERCRED_NOT_IMPLEMENTED`; use **operator_token** auth or inject `readPeerCred` in the control plane.

## Operator principal resolution

- Config or DB map: `uid` (number) → `{ operatorId: string, roles: string[] }`.
- Default single-operator: map file may be empty → treat configured `default_operator_uid` as sole operator, or deny unknown UIDs (per authorization policy).
- **Implemented:** `operator-map.ts` + JSON file schema in this package.

## Optional operator token

- Opaque secret in file (e.g. `/run/secrets/shoggoth_operator_token`); CLI sends `auth.kind === "operator_token"` on JSONL (still over Unix socket).
- Daemon: constant-time compare (SHA-256 or `crypto.timingSafeEqual` on raw bytes). Same **policy engine** as the peercred path; only authn differs.
- **Interface:** `validateOperatorToken(secret: string, presented: string): boolean` in `operator-token.ts`.

## Agent credentials

- At session spawn: mint random opaque token; persist **hash only** (e.g. SHA-256) with `session_id`, `created_at`, `revoked_at`.
- Inject raw token into agent env (e.g. `SHOGGOTH_AGENT_TOKEN`) or IPC; never operator secret.
- **validate:** hash presented token, lookup row, require session status active — **store interface** `AgentTokenStore` (SQLite-backed in production; in-memory for early tests).
- **Implemented:** `mintAgentCredential`, `hashAgentToken`, `timingSafeEqualToken` + in-memory `MemoryAgentTokenStore` for tests.

## JSONL wire format

- One JSON object per line (UTF-8), `\n` delimiter. No embedded raw newlines in frame (payloads must escape `\n` in strings per JSON).
- **Request:** `WireRequest` — `v`, `id`, `op`, `auth`, optional `payload`.
- **Response:** `WireResponse` — `v`, `id`, `ok`, `result` | `error`.
- **Versioning:** `v === 1` for this contract. Additive fields allowed (ignore unknown). Breaking changes bump `v` and require daemon + CLI capability negotiation later if needed.

## Integrations with other subsystems

- **Authorization / audit:** consumes `AuthenticatedPrincipal`, peer cred metadata, and audit `source`.
- **Sessions:** session spawn calls token minting and registers hash in DB-backed `AgentTokenStore`.
- **Events, messaging, memory indexing, etc.:** can proceed once authenticated RPC exists; they are not hard blockers for finishing this package’s contracts but assume the control wire is in place.
- **MCP / ACP integration:** builds on sessions + tool loop.

## Native peercred — reference C snippet (for future binding)

```c
// Linux only — getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len)
struct ucred cred;
socklen_t len = sizeof(cred);
if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) { /* handle */ }
// cred.pid, cred.uid, cred.gid
```
