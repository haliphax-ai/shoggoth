# builtin-ask

Present the user with a reaction-based choice prompt on the session's bound channel. Posts a message with an optional preamble and seeds one emoji reaction per choice; the user picks by reacting. Available only when the platform supports reactions (e.g. Discord).

This tool was split out of `builtin-message` so the two tools stay semantically separate: `builtin-message` handles general messaging, `builtin-ask` presents choices. It carries the same risk level as `builtin-message` (`caution`) and is enabled by default when a messaging runtime is active — nothing to enable via `builtin-discover`.

## Parameters

| Param     | Type   | Required | Notes                                                        |
| --------- | ------ | -------- | ------------------------------------------------------------ |
| `content` | string | no       | Preamble text shown above the choice legend.                 |
| `choices` | array  | yes      | Non-empty array of `{ emoji, label }` pairs for each option. |

Each choice item:

| Field   | Type   | Required | Notes                                                        |
| ------- | ------ | -------- | ------------------------------------------------------------ |
| `emoji` | string | yes      | Emoji to seed as a reaction (Unicode or platform shortcode). |
| `label` | string | yes      | Label text displayed next to the emoji.                      |

## Example

```json
{
  "content": "Pick one:",
  "choices": [
    { "emoji": "👍", "label": "Approve" },
    { "emoji": "👎", "label": "Reject" }
  ]
}
```

## Response format

The tool returns the created message plus counts of seeded reactions:

```json
{
  "ok": true,
  "message_id": "123456",
  "channel_id": "789",
  "choices": 2,
  "reactions_added": 2,
  "reactions_failed": 0
}
```

If some reactions could not be added, `reactions_failed` and `failed_reactions` are set along with a warning.

## Tips

- The posted message includes a "React to choose:" legend under the preamble.
- When invoked from a subagent, the posted prompt includes the standard provenance banner.
- Choice execution requires the platform's reaction capability; the tool is not advertised when reactions are unsupported.
