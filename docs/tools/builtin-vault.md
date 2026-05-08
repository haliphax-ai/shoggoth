# builtin-vault

Encrypted credential storage for agents. Secrets are scoped per-agent with global fallback.

## Actions

### get

Retrieve a credential by name. Checks agent scope first, then global.

```json
{ "action": "get", "name": "API_KEY" }
```

**Response:**

```json
{ "ok": true, "name": "API_KEY", "value": "sk-abc123" }
```

Returns `null` value if not found.

### set

Store a credential in the agent's own scope.

```json
{ "action": "set", "name": "MY_TOKEN", "value": "secret-value" }
```

**Response:**

```json
{ "ok": true, "name": "MY_TOKEN", "scope": "agent:developer" }
```

### delete

Remove a credential from the agent's own scope.

```json
{ "action": "delete", "name": "MY_TOKEN" }
```

**Response:**

```json
{ "ok": true, "name": "MY_TOKEN", "deleted": true }
```

### list

List all credentials visible to the agent (own scope + global). Values are not returned.

```json
{ "action": "list" }
```

**Response:**

```json
{
  "ok": true,
  "entries": [
    { "name": "API_KEY", "scope": "global", "metadata": null },
    { "name": "MY_TOKEN", "scope": "agent:developer", "metadata": "added 2026-05-08" }
  ]
}
```

### inject

Resolve a credential and deliver it via a one-time-read FIFO. The file self-destructs after being read.

```json
{ "action": "inject", "name": "API_KEY" }
```

**Response:**

```json
{
  "ok": true,
  "path": "/tmp/.vault/a1b2c3d4e5f6.fifo",
  "name": "API_KEY",
  "hint": "Use this path in your command. The file will be consumed on first read."
}
```

## Scope Enforcement

| Action | Reads from     | Writes to  |
| ------ | -------------- | ---------- |
| get    | agent + global | —          |
| set    | —              | agent only |
| delete | —              | agent only |
| list   | agent + global | —          |
| inject | agent + global | —          |

## Audit

The `value` field is automatically redacted from audit logs for all `builtin-vault` tool calls.

## Errors

- Missing `name` parameter: `{ "ok": false, "error": "name is required" }`
- Missing `value` for set: `{ "ok": false, "error": "value is required" }`
- Credential not found (inject): `{ "ok": false, "error": "credential not found" }`
