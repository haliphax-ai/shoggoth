# builtin-message

Messaging surface control for the session's bound channel. Pure passthrough — all args are forwarded to the channel plugin's `execute()`. Available actions depend on the platform's capabilities.

## Parameters

| Param                           | Type    | Required | Actions                                                                 | Notes                                                                                                                                                                                |
| ------------------------------- | ------- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action`                        | string  | yes      | all                                                                     | One of: `post`, `get`, `edit`, `delete`, `create_thread`, `delete_thread`, `react`, `choice`, `reactions`, `search`, `attachment-download`. Platform determines which are available. |
| `content`                       | string  | no       | post, choice, edit                                                      | Message body. For `choice`, preamble text before the choice legend. For `edit`, replacement text.                                                                                    |
| `message_id`                    | string  | no       | get, edit, delete, create_thread, react, reactions, attachment-download | Target message identifier. For `get`, fetches a single message. For `create_thread`, optional anchor message (omit for standalone thread).                                           |
| `name`                          | string  | no       | create_thread                                                           | Thread name.                                                                                                                                                                         |
| `thread_id`                     | string  | no       | delete_thread                                                           | Thread/channel identifier.                                                                                                                                                           |
| `channel_id`                    | string  | no       | get                                                                     | Channel or thread id; defaults to session's bound channel.                                                                                                                           |
| `limit`                         | integer | no       | get, search                                                             | Max messages to return (get default 10, max 100; search default 25).                                                                                                                 |
| `anchor_message_id`             | string  | no       | get                                                                     | Pivot message for pagination; use with `list_direction`.                                                                                                                             |
| `list_direction`                | string  | no       | get                                                                     | `before`, `after`, or `around` relative to `anchor_message_id`.                                                                                                                      |
| `reply_to_message_id`           | string  | no       | post                                                                    | Platform message id to reply to.                                                                                                                                                     |
| `attachments`                   | array   | no       | post                                                                    | Files as `[{ filename, content_base64 }]`.                                                                                                                                           |
| `auto_archive_duration_minutes` | integer | no       | create_thread                                                           | One of: 60, 1440, 4320, 10080.                                                                                                                                                       |
| `emoji`                         | string  | no       | react, reactions                                                        | Unicode or platform shortcode (e.g. `✅`, `<:custom:123>`).                                                                                                                          |
| `remove`                        | boolean | no       | react                                                                   | If true, remove the reaction. Default false.                                                                                                                                         |
| `choices`                       | array   | no       | choice                                                                  | `[{ emoji, label }]` pairs for reaction-based choice prompt.                                                                                                                         |
| `query`                         | string  | no       | search                                                                  | Free-text keyword search.                                                                                                                                                            |
| `author_id`                     | string  | no       | search                                                                  | Filter to a specific user id.                                                                                                                                                        |
| `author_ids`                    | array   | no       | search                                                                  | Filter to any of these user ids.                                                                                                                                                     |
| `before`                        | string  | no       | search                                                                  | Messages before this message id or ISO timestamp.                                                                                                                                    |
| `after`                         | string  | no       | search                                                                  | Messages after this message id or ISO timestamp.                                                                                                                                     |
| `from_me`                       | boolean | no       | search                                                                  | Filter to bot/agent's own messages.                                                                                                                                                  |
| `channel_ids`                   | array   | no       | search                                                                  | Search across multiple channels.                                                                                                                                                     |
| `filename`                      | string  | no       | attachment-download                                                     | Specific filename when message has multiple attachments.                                                                                                                             |
| `index`                         | integer | no       | attachment-download                                                     | 0-based attachment index (default 0).                                                                                                                                                |
| `path`                          | string  | no       | attachment-download                                                     | Local save path; defaults to workspace downloads dir.                                                                                                                                |

## Examples

**Post a message:**

```json
{ "action": "post", "content": "Hello from the agent." }
```

**Reply to a message:**

```json
{ "action": "post", "content": "Got it.", "reply_to_message_id": "123456" }
```

**Read latest messages:**

```json
{ "action": "get", "limit": 5 }
```

**Read a single message:**

```json
{ "action": "get", "message_id": "123456" }
```

**Edit a message:**

```json
{ "action": "edit", "message_id": "123456", "content": "Updated text." }
```

**Delete a message:**

```json
{ "action": "delete", "message_id": "123456" }
```

**Create a thread from a message:**

```json
{ "action": "create_thread", "message_id": "123456", "name": "Discussion" }
```

**Create a standalone thread (no anchor message):**

```json
{ "action": "create_thread", "name": "New topic" }
```

**Add a reaction:**

```json
{ "action": "react", "message_id": "123456", "emoji": "✅" }
```

**Post a reaction choice prompt:**

```json
{
  "action": "choice",
  "content": "Pick one:",
  "choices": [
    { "emoji": "👍", "label": "Approve" },
    { "emoji": "👎", "label": "Reject" }
  ]
}
```

**Search messages:**

```json
{ "action": "search", "query": "deploy", "limit": 10 }
```

**Download an attachment:**

```json
{
  "action": "attachment-download",
  "message_id": "123456",
  "path": "downloads/report.pdf"
}
```

## Tips

- Regular assistant replies are delivered by the platform automatically — use this tool only for explicit messaging operations.
- Only actions supported by the current platform appear in `action`'s enum; unsupported actions will not be offered.
- The schema is intentionally flat (no `oneOf`/`anyOf`) for broad model compatibility. Per-action requirements are enforced at execution time.
