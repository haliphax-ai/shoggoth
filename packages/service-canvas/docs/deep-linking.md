# Deep Linking — `shoggoth://` URLs

The canvas server supports `shoggoth://` deep links that allow rendered canvas content to trigger agent runs. This creates a feedback loop where agents can build interactive UIs with actionable links.

## How It Works

1. An agent pushes HTML content to the canvas (via file-served HTML or `data:` URLs)
2. The server injects a script into served HTML that intercepts clicks on `shoggoth://` links
3. The SPA surfaces a confirmation dialog showing the message and options
4. On confirmation, the request is sent to the canvas server's `/api/agent` endpoint
5. The server calls `sessionsSpawn` in-process via the plugin's trusted identity (no token needed)

## URL Schemes

Three custom URL schemes are supported:

| Scheme                   | Purpose                   | Example                                           |
| ------------------------ | ------------------------- | ------------------------------------------------- |
| `shoggoth://`            | Agent deep links          | `shoggoth://agent?message=Run+the+tests`          |
| `shoggoth-fileprompt://` | File-based subagent spawn | `shoggoth-fileprompt://jsonl/task.md?agentId=dev` |
| `shoggoth-canvas://`     | Session file references   | `shoggoth-canvas://my-project/logo.png`           |

A shared utility (`src/server/shared/url-schemes.ts`) provides `parseShoggothUrl()` for parsing all three schemes.

### `shoggoth://` — Agent Deep Links

```
shoggoth://agent?message=<text>&sessionKey=<key>&agentId=<id>&model=<model>&thinking=<mode>
```

```
shoggoth://agent?message=Run+the+tests
```

### Parameters

| Parameter        | Required | Description                                                                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`        | Yes      | The message to send to the agent                                                                                                                             |
| `agentId`        | No       | Target agent ID (uses default if omitted)                                                                                                                    |
| `model`          | No       | Model override (e.g. `claude-sonnet-4-20250514`)                                                                                                             |
| `sessionKey`     | No       | Parent session key for completion announcements. Defaults to `"devnull"` (suppresses announcements). Set to a real session key to receive completion events. |
| `thinking`       | No       | Thinking mode: `on`, `off`, or `stream`                                                                                                                      |
| `deliver`        | No       | Delivery mode for the response                                                                                                                               |
| `to`             | No       | Delivery target                                                                                                                                              |
| `channel`        | No       | Delivery channel                                                                                                                                             |
| `timeoutSeconds` | No       | Timeout for the agent run                                                                                                                                    |

## Confirmation Dialog

When a user clicks a `shoggoth://` link, a confirmation dialog appears showing:

- The message that will be sent to the agent (truncated to 300 characters)
- An expandable "Options" section with:
  - Agent selector (populated from the canvas config's agent list)
  - Model override text input
  - Thinking mode selector (default/on/off/stream)
  - Session key override

The user must click "Send" to execute the deep link. Clicking "Cancel" or the overlay dismisses it.

### Skipping Confirmation

The confirmation dialog can be disabled via the canvas config by setting `skipConfirm: true` in `services.canvas`. Use with caution — this allows any rendered canvas content to trigger agent runs without user approval.

## Script Injection

The server automatically injects a deep link handler script into HTML content served through the canvas file routes (`/_c/:session/*`). The injected script:

1. Listens for click events on `<a>` elements with `href` starting with `shoggoth://`
2. Prevents the default navigation
3. Sends a `postMessage` to the parent SPA frame with the URL
4. The SPA's CanvasView receives the message and shows the confirmation dialog

This works for both file-served HTML and inline content. For `data:` URLs, the script is injected into the iframe's content document.

## Example: Interactive Dashboard

An agent can build a dashboard with actionable links:

```html
<h2>Failing CI Checks</h2>
<ul>
  <li>
    service-canvas — test workflow
    <a href="shoggoth://agent?message=Fix+the+failing+test+in+service-canvas">Fix this</a>
  </li>
  <li>
    skills — validate workflow
    <a href="shoggoth://agent?message=Fix+the+schema+validation+in+the+skills+repo">Fix this</a>
  </li>
</ul>
```

When the user clicks "Fix this", the confirmation dialog appears, and on approval, the agent receives the message and can act on it.

## File-Based Subagent Spawn — `shoggoth-fileprompt://` URLs

The `shoggoth-fileprompt://` scheme spawns a subagent whose **task** is the **full text** of a file on the canvas host. The canvas server's `/api/file-spawn` endpoint reads that file and passes its contents to `sessionsSpawn` directly (in-process, trusted identity — no HTTP proxy or token).

### URL format

```
shoggoth-fileprompt://<path>?agentId=<id>&model=<model>&sessionKey=<key>
```

**`<path>` is not a query parameter.** It is the URL path immediately after `shoggoth-fileprompt://` (everything before `?`). For example, to load `jsonl/instructions.md` under the resolved root below, use:

```
shoggoth-fileprompt://jsonl/instructions.md?agentId=developer
```

The SPA parses this into `{ path: "jsonl/instructions.md", params: { agentId: "developer", ... } }` and POSTs to `/api/file-spawn` with JSON `{ "file": "jsonl/instructions.md", "agentId": "developer", ... }`. The JSON field is named `file` for historical reasons; it is **always** populated from the URL path, not from `?file=`.

### Where files are read from

The server resolves the file with `path.resolve(root, <path>)` where `root` is:

1. **If `agentId` is set and matches an entry in `agentWorkspaces` config:**
   `<that agent's workspace>/canvas`
   (e.g. `/var/lib/shoggoth/workspaces/developer/canvas` for agent `developer`).
2. **Otherwise:** the `basePath` from `services.canvas` config.

Prompts are read from the agent's **`canvas/`** directory (often `canvas/jsonl/...`), not from the full agent workspace above `canvas/`. Path traversal outside `root` is rejected.

### Query parameters

| Parameter    | Required | Description                                                                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`    | No       | Selects which agent's workspace `canvas/` directory is used to resolve `<path>` when the agent is configured in `agentWorkspaces`. |
| `model`      | No       | Model override forwarded to `sessionsSpawn`.                                                                                       |
| `sessionKey` | No       | Same as `shoggoth://`: target session for completion announcements. Omitted → `"devnull"` (see below).                             |

### Example (HTML)

```html
<a href="shoggoth-fileprompt://jsonl/deploy-notes.md?agentId=developer">Deploy</a>
```

## API Proxy

Deep link execution is handled by the canvas server's `/api/agent` endpoint, which calls `sessionsSpawn` in-process via the plugin's trusted identity. No HTTP proxy, no external gateway, no token.

```
Client → POST /api/agent { message, agentId, model?, sessionKey?, ... }
       → sessionsSpawn (in-process, trusted identity)
       → Isolated subagent run triggered

Client → POST /api/file-spawn { file: "<path from URL>", agentId?, model?, sessionKey?, ... }
       → Read file under <agent workspace>/canvas
       → sessionsSpawn (in-process, trusted identity)
       → Subagent run triggered with file contents as task
```

### Suppressing Completion Announcements

By default, `sessionsSpawn` auto-announces completion back to the parent session, which costs tokens. **Both** `/api/agent` and `/api/file-spawn` set `sessionKey` to `"devnull"` when it is omitted — a nonexistent session that silently drops the announcement.

To route the completion to a specific session instead (e.g., for monitoring), pass `sessionKey` in the URL query string for **either** scheme:

```
shoggoth://agent?message=Refresh+data&agentId=developer&sessionKey=agent:developer:discord:channel:123
```

```
shoggoth-fileprompt://jsonl/task.md?agentId=developer&sessionKey=agent:developer:discord:channel:123
```

If `sessionKey` is omitted, it defaults to `"devnull"` (no announcement).

## Canvas Config Endpoint

The `/api/canvas-config` endpoint provides client-side configuration:

```json
{
  "skipConfirmation": false,
  "agents": ["developer", "assistant", "editor"],
  "allowedAgentIds": ["developer", "assistant"]
}
```

- `agents` — List of available agent IDs for the confirmation dialog's agent selector
- `allowedAgentIds` — Agent IDs permitted for deep link execution
- `skipConfirmation` — Whether to bypass the confirmation dialog

## A2UI Button Deep Links

A2UI Button components support deep links via the `href` prop. Unlike iframe-based deep links, A2UI buttons POST directly to the appropriate API endpoint without showing a confirmation dialog. This is appropriate for trusted A2UI content where the agent controls the button labels and URLs.

Agent trigger:

```json
{
  "Button": {
    "label": "Refresh",
    "href": "shoggoth://agent?message=Refresh+data&agentId=developer"
  }
}
```

File-spawn trigger (path is under that agent's `canvas/` directory):

```json
{
  "Button": {
    "label": "Deploy",
    "href": "shoggoth-fileprompt://jsonl/deploy-notes.md?agentId=developer"
  }
}
```

## Security Considerations

- All deep links require user confirmation by default (confirmation dialog)
- The `allowedAgentIds` list restricts which agents can be targeted
- Deep links are handled by the canvas server's in-process `sessionsSpawn` — no external network calls
- Path traversal is blocked in file-spawn URLs
