# JSONL File Watcher (Auto-Push)

The canvas server includes a file watcher that monitors each agent's `canvas/jsonl/` directory. When `.jsonl` files are created or modified, the server automatically reads and pushes each line as an A2UI command — no manual tool call needed.

## How it works

1. On startup, the server creates a chokidar watcher on each configured agent's `<workspace>/canvas/jsonl/` directory (configured via `agentWorkspaces` in `services.canvas`)
2. When a `.jsonl` file is created or modified, the watcher debounces (300ms) then reads the file
3. Each line is parsed as JSON and processed as an A2UI command (`updateComponents`, `createSurface`, `updateDataModel`, `dataSourcePush`, `deleteSurface`)
4. Commands are applied to the A2UI manager (persisted in SQLite) and broadcast to connected SPA clients

## Usage

Write JSONL files to your agent's `canvas/jsonl/` directory:

```bash
# Layout file
cat > /var/lib/shoggoth/workspaces/developer/canvas/jsonl/dashboard-layout.jsonl << 'EOF'
{"updateComponents":{"surfaceId":"main","components":[{"id":"root","component":"Column","children":["title","table"]}]}}
{"updateComponents":{"surfaceId":"main","components":[{"id":"title","component":"Text","text":"Dashboard"}]}}
{"createSurface":{"surfaceId":"main","root":"root"}}
EOF

# Data file (can target the same surfaceId)
cat > /var/lib/shoggoth/workspaces/developer/canvas/jsonl/dashboard-data.jsonl << 'EOF'
{"dataSourcePush":{"surfaceId":"main","sources":{"users":{"fields":["name","role"],"rows":[{"name":"Alice","role":"admin"}]}}}}
EOF
```

## Multiple files per surface

Multiple `.jsonl` files can target the same `surfaceId`. They merge in the SQLite cache — layout in one file, data in another. This lets you update data independently of component structure.

## Session mapping

The session is derived from the `agentWorkspaces` config mapping:

```json
{
  "services": {
    "canvas": {
      "agentWorkspaces": {
        "developer": "/var/lib/shoggoth/workspaces/developer",
        "assistant": "/var/lib/shoggoth/workspaces/assistant"
      }
    }
  }
}
```

- `<workspace>/canvas/jsonl/` → session matches the agent ID key

## Error handling

- Invalid JSON lines are skipped with a warning log
- If a file is deleted before the debounce fires, the read is silently skipped
- The watcher is cleaned up on server shutdown

## Configuration

- Debounce interval: 300ms (hardcoded)
- The `jsonl/` directory is excluded from the iframe file watcher (no duplicate reload events)
- Watched directories are configured via `agentWorkspaces` in `services.canvas`
