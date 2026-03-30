# Canvas / openclaw-canvas-web bridge

Shoggoth does **not** embed the `openclaw-canvas-web` SPA. The daemon exposes **`canvas_authorize`** on the **control Unix socket** so any surface that can present or push A2UI (including canvas-web, a fork, or a separate gateway service) can ask the policy engine whether the current principal may act on a **target session** before performing the equivalent of `canvas.present`, `canvas.push` / `canvas.a2ui.push`, or `canvas.navigate`.

## Actions and mapping

| Shoggoth `canvas_authorize` `payload.action` | Typical openclaw-canvas-web command |
| -------------------------------------------- | ------------------------------------ |
| `canvas.present`                             | `canvas.present`, `canvas.show`      |
| `canvas.push`                                | `canvas.a2ui.push`, `canvas.a2ui.pushJSONL` |
| `canvas.navigate`                            | `canvas.navigate`, `canvas.navigateExternal` (when scoped to a session path) |

Always pass **`resource_session_id`** as the canvas **session** the UI change applies to (the path segment in `/<session>/…` on the canvas server). Agents may only authorize operations where `resource_session_id` equals their **Shoggoth session id** (the one bound via ACPX / agent token). Operators may authorize any session.

## Control wire (JSONL)

One request line per connection; read one response line. Wire version **`v`: 1** (see `@shoggoth/authn`).

**Request**

```json
{
  "v": 1,
  "id": "unique-string",
  "op": "canvas_authorize",
  "auth": {
    "kind": "agent",
    "session_id": "<shoggoth_session_id>",
    "token": "<agent_token>"
  },
  "payload": {
    "action": "canvas.push",
    "resource_session_id": "<canvas_session / shoggoth session>"
  }
}
```

Operator scripting may use `auth.kind: "operator_token"` with `auth.token`, or `operator_peercred` from a process connected over the socket with valid peer credentials.

**Success response**

```json
{
  "v": 1,
  "id": "unique-string",
  "ok": true,
  "result": { "allow": true }
}
```

or

```json
{
  "v": 1,
  "id": "unique-string",
  "ok": true,
  "result": { "allow": false, "reason": "agent_cannot_touch_foreign_session_canvas" }
}
```

**Error response** uses `ok: false` and `error: { code, message }` (e.g. invalid payload, forbidden op).

## Policy defaults

- **Operator** `controlOps.allow` includes `canvas_authorize`.
- **Agent** allowlist includes `canvas_authorize` (see `DEFAULT_POLICY_CONFIG` in `@shoggoth/shared`).

Authorization rules live in `@shoggoth/mcp-integration` (`authorizeCanvasAction`); the daemon applies them in `handleIntegrationControlOp` (`integration-ops.ts`).

## Minimal HTTP hook (loopback)

Processes that only speak HTTP (or containers without a direct socket mount) can run the **optional** helper:

```bash
SHOGGOTH_CONTROL_SOCKET=/run/shoggoth/control.sock \
CANVAS_AUTHORIZE_HOOK_PORT=18081 \
node scripts/canvas-authorize-hook/server.mjs
```

**POST** `/` with `Content-Type: application/json` body:

```json
{
  "id": "http-1",
  "auth": {
    "kind": "agent",
    "session_id": "my-session",
    "token": "…"
  },
  "payload": {
    "action": "canvas.push",
    "resource_session_id": "my-session"
  }
}
```

**Response:** JSON `{ "allow": boolean, "reason?": string }` on success, or `{ "error": "…" }` with HTTP 400/502 as appropriate.

Bind defaults to **127.0.0.1**. Do not expose this port outside the host; it forwards to the full control plane.

## Docker Compose snippet

Share the daemon socket with the hook and (optionally) the canvas container. Example **fragments** (adjust paths to your image layout):

```yaml
services:
  shoggoth:
    volumes:
      - shoggoth-run:/run/shoggoth

  canvas-authorize-hook:
    image: shoggoth:local
    user: shoggoth
    command:
      - node
      - /app/scripts/canvas-authorize-hook/server.mjs
    environment:
      SHOGGOTH_CONTROL_SOCKET: /run/shoggoth/control.sock
      CANVAS_AUTHORIZE_HOOK_HOST: "0.0.0.0"
      CANVAS_AUTHORIZE_HOOK_PORT: "18081"
    volumes:
      - shoggoth-run:/run/shoggoth:ro
    depends_on:
      - shoggoth
    # Keep on an internal network; do not publish 18081 publicly without TLS and auth in front.

volumes:
  shoggoth-run:
```

If the hook listens on `0.0.0.0`, restrict with **Docker network policies** or an internal bridge only. Prefer **127.0.0.1** on the host and a shared volume for the socket when canvas-web runs on the same machine as the daemon.

## Integrating openclaw-canvas-web

Today the canvas server forwards tool-style commands through the **OpenClaw gateway**. To enforce Shoggoth authz:

1. **Before** emitting `canvas.present`, `canvas.a2ui.push`, `canvas.a2ui.pushJSONL`, or session-scoped `canvas.navigate`, call **`canvas_authorize`** with the same principal you use for other Shoggoth tools (agent token from `SHOGGOTH_AGENT_TOKEN` when running under ACPX).
2. If `result.allow` is false, reject the canvas operation and log `reason`.
3. Optionally gate this behind config (e.g. `SHOGGOTH_CANVAS_AUTHZ=1` + socket path) so single-gateway installs stay unchanged.

A small patch in canvas-web’s node command handler (or a middleware in front of WebSocket tool dispatch) is the natural integration point; this repository documents the contract only.

## Automated tests (repo)

- `@shoggoth/mcp-integration`: `canvas-authz.test.ts` (pure policy).
- `@shoggoth/daemon`: `control-plane.test.ts` — `canvas_authorize` over the real control socket with agent auth.
- Root: `node --test scripts/canvas-authorize-hook/wire.test.mjs` (wire framing for the HTTP hook).

## Manual checklist

1. Start the daemon with a state DB and known socket path.
2. Create session `S`, register agent token `T` (existing session/tokens path).
3. **Allow path:** send `canvas_authorize` with `auth: agent`, `session_id: S`, `token: T`, `payload.action: canvas.push`, `resource_session_id: S` → expect `{ allow: true }`.
4. **Deny path:** same auth, `resource_session_id: other` → expect `allow: false` and reason `agent_cannot_touch_foreign_session_canvas`.
5. **HTTP hook:** start `server.mjs`, POST the JSON body from §Minimal HTTP hook, confirm responses match steps 3–4.
6. **Invalid action:** `payload.action: "canvas.nope"` → wire error `ERR_INVALID_PAYLOAD`.

## See also

- [acpx.md](./acpx.md) — agent env vars including `SHOGGOTH_CONTROL_SOCKET` and `SHOGGOTH_AGENT_TOKEN`.
- [SHOGGOTH-PLAN.md](../SHOGGOTH-PLAN.md) — product note on canvas / A2UI.
