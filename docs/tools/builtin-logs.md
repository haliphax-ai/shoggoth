# builtin-logs

View Shoggoth daemon logs by piping them through a [jq](https://jqlang.github.io/jq/) filter. The daemon writes its JSON-lines logs to date-stamped files in a directory outside all agent workspaces (default `/var/log/shoggoth`); this tool is the compartmentalized access path — agents never need (or get) filesystem access to that directory.

**Hidden by default** and classified `critical` for HITL. Enable it for a session with `builtin-discover`.

## Parameters

| Param     | Type    | Required | Notes                                                                                                |
| --------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `filter`  | string  | yes      | jq program applied to each JSON log line                                                             |
| `days`    | integer | no       | Days back to include (today + N-1 previous; rotated `.log.gz` are decompressed). Default: 1. Max: 31 |
| `tail`    | integer | no       | Only the most recent N lines of the window are fed to jq. Default: 5000. Max: 20000                  |
| `compact` | boolean | no       | One compact JSON value per input line. Default: true                                                 |

## Return Value Structure

```json
{
  "output": "\"boom\"\n\"kaboom\"\n"
}
```

On failure the result contains an `error` string instead: a validation failure (e.g. unbalanced brackets in the filter), `no log files found for the requested window`, or the jq error output (compile/runtime errors are surfaced verbatim).

## Examples

**Error records from the last hour (filter by timestamp after pulling):**

```json
{ "filter": "select(.level == \"error\")" }
```

**Messages from one component:**

```json
{ "filter": "select(.component == \"shoggoth-daemon\") | .msg" }
```

**Count records by level over the last 3 days:**

```json
{
  "filter": "group_by(.level) | map({level: .[0].level, count: length})",
  "days": 3,
  "compact": false
}
```

**Tail only the last 100 lines:**

```json
{ "filter": ".", "tail": 100 }
```

## Behavior Notes

- Log records are JSON objects with `ts`, `level`, `msg`, `component`, plus any structured fields.
- Files are named `shoggoth-YYYY-MM-DD.log` (UTC); rotated days are gzipped to `.log.gz` and read transparently by this tool.
- The filter is validated (length, balanced brackets, terminated strings) before jq runs, but jq is the authority — its errors are returned as-is.
- jq is spawned with a minimal environment, a hard timeout, and log input capped in size, so a hostile or runaway filter cannot hang or exhaust the daemon.
- Output is capped like other tools (large results are truncated with a notice).
