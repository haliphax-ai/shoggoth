# builtin-discover

Enable, disable, list, or reset available tools for the current session. Requires tool discovery to be enabled in config.

## Parameters

| Param     | Type     | Required | Notes                                                |
| --------- | -------- | -------- | ---------------------------------------------------- |
| `enable`  | string[] | no       | Tool IDs (or globs like `kanban-*`) to enable        |
| `disable` | string[] | no       | Tool IDs to disable (`alwaysOn` tools are rejected)  |
| `reset`   | boolean  | no       | Clear all session tool state before applying changes |
| `list`    | boolean  | no       | Return the full tool catalog in the response         |

All params are optional but at least one should be provided. Processing order: `reset` → `enable` → `disable`.

## Examples

**List all available tools:**

```json
{ "list": true }
```

**Enable specific tools:**

```json
{ "enable": ["web_search", "browser"] }
```

**Disable a tool:**

```json
{ "disable": ["tts"] }
```

**Reset to defaults and enable a subset:**

```json
{ "reset": true, "enable": ["read", "write", "exec"], "list": true }
```

## Response Shape

```json
{
  "applied": {
    "enabled": ["web_search"],
    "disabled": ["tts"],
    "reset": true,
    "rejected": [{ "id": "builtin-read", "reason": "always_on" }]
  },
  "catalog": [
    {
      "id": "read",
      "description": "Read files",
      "enabled": true,
      "alwaysOn": true
    },
    {
      "id": "tts",
      "description": "Text to speech",
      "enabled": false,
      "alwaysOn": false
    }
  ]
}
```

`catalog` is only present when `list: true`. `rejected` entries use reason `"always_on"` or `"invalid_id"`.

## Tips

- Combine `reset` with `enable` to start from a clean slate with only the tools you need.
- `alwaysOn` tools cannot be disabled — attempts are silently rejected (check `applied.rejected`).
- Use `list: true` alongside mutations to confirm the resulting state in one call.
