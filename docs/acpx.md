# ACP / acpx integration

Shoggoth persists **ACP workspace roots** → **Shoggoth session id** + **agent principal id** in SQLite (`acpx_workspace_bindings`). The daemon can **start and stop** a managed `acpx` child per bound workspace and writes **audit rows** for lifecycle events.

## Configuration

Optional fragment (layered JSON):

```json
{
  "acpx": {
    "binary": "acpx",
    "defaultArgs": ["openclaw", "exec", "idle"]
  }
}
```

- **`binary`**: Executable name or path (default `acpx` on `PATH`).
- **`defaultArgs`**: Argv after the binary when a control request omits `acpx_args`.

Full merged config may include `acpx`; omit the block to require `acpx_args` on every start.

## Operator flow

1. **Create** a Shoggoth session (existing path: session manager / tooling) so a row exists in `sessions` and agent tokens can be minted.
2. **Bind** the ACP workspace directory to that session:

   - Control op `acpx_bind_set` with payload:
     - `acp_workspace_root` — directory `acpx` uses as `--cwd` (normalized path recommended).
     - `shoggoth_session_id` — UUID for the session you created in the previous step.
     - `agent_principal_id` — opaque id for your runbook (e.g. subagent name).

3. **Start** a managed process:

   - Control op `acpx_agent_start` with payload:
     - `acp_workspace_root` — must match a binding.
     - `acpx_args` (optional if `config.acpx.defaultArgs` is set) — argv after the binary, e.g. `["openclaw", "exec", "summarize logs"]`.

   The daemon **rotates** the session agent token, then spawns `acpx` with `cwd` = `acp_workspace_root`. The raw token is **only** passed in the child environment, never in the JSON response.

4. **Stop** when finished:

   - Control op `acpx_agent_stop` with `acp_workspace_root`. Sends `SIGTERM` to the tracked PID.

5. **List** running managed processes (operator):

   - Control op `acpx_agent_list` → `{ processes: [{ pid, shoggoth_session_id, started_at_ms }] }`.

6. On daemon shutdown, registered drains **SIGTERM** all managed acpx children before the control socket closes.

## Environment injected into the acpx child

| Variable | Purpose |
|----------|---------|
| `SHOGGOTH_CONTROL_SOCKET` | Unix socket path for the control plane (JSONL wire). |
| `SHOGGOTH_SESSION_ID` | Bound session id. |
| `SHOGGOTH_AGENT_TOKEN` | Freshly minted credential for `auth.kind: "agent"` requests. |
| `SHOGGOTH_ACPX_WORKSPACE_ROOT` | Same as `acp_workspace_root` (hint for tooling). |

Constants are exported from `@shoggoth/mcp-integration` as `SHOGGOTH_CONTROL_SOCKET_ENV`, etc.

## Audit

Besides the usual `authz.control` row per op, successful lifecycle calls append:

- `action`: `acpx.agent_start` or `acpx.agent_stop`
- `resource`: ACP workspace root
- `outcome`: `ok`, `not_running` (stop when nothing tracked), etc.
- `args_redacted_json`: metadata such as `pid`, `shoggoth_session_id`, `binary` (no token).

## Policy

Operator allowlist includes `acpx_agent_start`, `acpx_agent_stop`, and `acpx_agent_list`. Agents do not receive these ops by default.

## Errors (non-exhaustive)

| Code | Meaning |
|------|---------|
| `ERR_ACPX_BINDING_NOT_FOUND` | No row for `acp_workspace_root`. |
| `ERR_SESSION_INACTIVE` | Session missing or `terminated`. |
| `ERR_ACPX_ALREADY_RUNNING` | Start requested while a process is already tracked for that root. |
| `ERR_ACPX_RUNTIME_UNAVAILABLE` | State DB / session stack not available. |
| `ERR_INVALID_PAYLOAD` | Missing `acpx_args` and no `config.acpx.defaultArgs`. |
