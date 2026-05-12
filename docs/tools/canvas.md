# canvas

The Canvas service plugin (`@shoggoth/service-canvas`) provides tools for managing a browser-based canvas surface connected via WebSocket. Agents use these tools to present content, navigate, execute JavaScript, take snapshots, and push reactive A2UI data to connected clients.

## Configuration

Canvas is configured via `services.canvas` in the Shoggoth config (no environment variables):

```json
{
  "services": {
    "canvas": {
      "host": "127.0.0.1",
      "port": 3100,
      "basePath": "/"
    }
  }
}
```

All fields are optional and fall back to defaults.

## Session Scoping

All tools that accept a `session` parameter use a composite key (surfaceId + session URN) to route messages to the correct connected client. If `session` is omitted, the tool uses the calling agent's `sessionUrn` from context.

## Tools

---

### canvas.present

Present a canvas surface to a session. Opens or shows the canvas for the user.

| Param     | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `session` | string | yes      | Session ID to present the canvas to |
| `target`  | string | no       | Target canvas ID to present         |
| `surface` | string | no       | Surface name to display             |

```json
{
  "session": "agent:dev:discord:channel:123",
  "target": "editor",
  "surface": "main"
}
```

---

### canvas.hide

Hide the canvas from all connected sessions. Broadcasts globally.

No parameters required.

```json
{}
```

---

### canvas.navigate

Navigate a session's canvas to a path or URL.

| Param     | Type   | Required | Description                  |
| --------- | ------ | -------- | ---------------------------- |
| `session` | string | yes      | Session ID to navigate       |
| `path`    | string | no¹      | Relative path to navigate to |
| `url`     | string | no¹      | Full URL to navigate to      |

¹ Provide at least one of `path` or `url`.

```json
{
  "session": "agent:dev:discord:channel:123",
  "url": "https://example.com/dashboard"
}
```

---

### canvas.eval

Execute JavaScript in a session's canvas context.

| Param     | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `session` | string | yes      | Session ID to execute JS in |
| `js`      | string | yes      | JavaScript code to execute  |

```json
{
  "session": "agent:dev:discord:channel:123",
  "js": "document.title"
}
```

---

### canvas.snapshot

Request a screenshot of a session's canvas. Returns base64-encoded PNG data.

| Param     | Type   | Required | Description                    |
| --------- | ------ | -------- | ------------------------------ |
| `session` | string | yes      | Session ID to take snapshot of |

```json
{
  "session": "agent:dev:discord:channel:123"
}
```

**Response:**

```json
{
  "ok": true,
  "snapshot": "iVBORw0KGgo..."
}
```

**Limitations:** Snapshots are subject to same-origin restrictions in the browser. Cross-origin iframes or content may appear blank.

---

### canvas.a2ui.push

Push A2UI (Agent-to-User Interface) reactive data to a session. The connected SPA renders the payload using registered catalog components.

| Param     | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `session` | string | yes      | Session ID to push data to |
| `payload` | object | yes      | A2UI payload data          |

```json
{
  "session": "agent:dev:discord:channel:123",
  "payload": {
    "component": "chart",
    "data": { "labels": ["A", "B"], "values": [10, 20] }
  }
}
```

---

### canvas.a2ui.pushJSONL

Push A2UI data as JSONL to a session. Functionally identical to `canvas.a2ui.push`.

| Param     | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `session` | string | yes      | Session ID to push data to |
| `payload` | object | yes      | A2UI payload data          |

---

### canvas.a2ui.reset

Reset/clear all A2UI state for a session.

| Param     | Type   | Required | Description         |
| --------- | ------ | -------- | ------------------- |
| `session` | string | yes      | Session ID to reset |

```json
{
  "session": "agent:dev:discord:channel:123"
}
```

---

## Deep Links

The canvas supports deep link URL schemes for cross-application navigation:

| Scheme                   | Purpose                            |
| ------------------------ | ---------------------------------- |
| `shoggoth://`            | Agent interaction deep links       |
| `shoggoth-fileprompt://` | File-based prompt spawning         |
| `shoggoth-canvas://`     | Cross-session canvas URL rewriting |

## Proxy Routes

The canvas server exposes two HTTP endpoints for operator-initiated session spawning:

- **POST `/api/agent`** — Spawn a session with a text message. Uses the plugin's trusted identity (no token required).
- **POST `/api/file-spawn`** — Read a file and spawn a session with its content. Includes path traversal guards.

Both routes call Shoggoth's in-process `sessionsSpawn` directly rather than proxying to an external gateway.

## A2UI Catalog System

The canvas uses a catalog system for registering UI components:

- `@shoggoth/a2ui-sdk` — SDK for building catalog packages
- `@shoggoth/a2ui-catalog-basic` — Basic component set
- `@shoggoth/a2ui-catalog-extended` — Extended components
- `@shoggoth/a2ui-catalog-all` — Meta-package including all catalogs
