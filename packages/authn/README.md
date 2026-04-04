# Shoggoth — Authentication (`@shoggoth/authn`)

Unix control socket, operator token, agent token mint/validate, JSONL wire.

- **Source:** `src/` (TypeScript)
- **Tests:** `test/` (`npm run test`)

## Integration status

The **`@shoggoth/daemon`** control plane consumes this package (JSONL wire and agent tokens). This README is the detailed authn contract.

## Unix domain socket

- Path from layered config (e.g. `control.socket.path`, default `/run/shoggoth/control.sock`).
- Create with `umask` / `fs.chmod` so only operator GID or UID can connect (exact mode documented in the operator image layout).
- **Daemon:** listener and auth wiring live in `@shoggoth/daemon` (`control-plane.ts`).

## Operator token

- Opaque secret in file (e.g. `/run/secrets/shoggoth_operator_token`); CLI sends `auth.kind === "operator_token"` on JSONL (over Unix socket).
- Daemon: constant-time compare (SHA-256 via `crypto.timingSafeEqual`). Same **policy engine** for authorization.
- **Interface:** `validateOperatorToken(secret: string, presented: string): boolean` in `operator-token.ts`.
- **CLI:** `SHOGGOTH_OPERATOR_TOKEN` env var is required for all CLI commands.

## Agent credentials

- At session spawn: mint random opaque token; persist **hash only** (e.g. SHA-256) with `session_id`, `created_at`, `revoked_at`.
- Inject raw token into agent env (e.g. `SHOGGOTH_AGENT_TOKEN`) or IPC; never operator secret.
- **validate:** hash presented token, lookup row, require session status active — **store interface** `AgentTokenStore` (SQLite-backed in production; in-memory for early tests).
- **Implemented:** `mintAgentCredential`, `hashAgentToken`, `timingSafeEqualToken` + in-memory `MemoryAgentTokenStore` for tests.

## JSONL wire format

- One JSON object per line (UTF-8), `\n` delimiter. No embedded raw newlines in frame (payloads must escape `\n` in strings per JSON).
- **Request:** `WireRequest` — `v`, `id`, `op`, `auth`, optional `payload`.
- **Response:** `WireResponse` — `v`, `id`, `ok`, `result` | `error`.
- **Auth kinds:** `operator_token`, `agent`.
- **Versioning:** `v === 1` for this contract. Additive fields allowed (ignore unknown). Breaking changes bump `v` and require daemon + CLI capability negotiation later if needed.

## Integrations with other subsystems

- **Authorization / audit:** consumes `AuthenticatedPrincipal` and audit `source`.
- **Sessions:** session spawn calls token minting and registers hash in DB-backed `AgentTokenStore`.
- **Events, messaging, memory indexing, etc.:** can proceed once authenticated RPC exists; they are not hard blockers for finishing this package's contracts but assume the control wire is in place.
- **MCP / ACP integration:** builds on sessions + tool loop.
