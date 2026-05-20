# @shoggoth/service-demo

A demo service that works in two modes:

1. **Plugin mode** — loaded by the daemon at startup via the plugin system
2. **Managed service mode** — runs as a standalone HTTP process managed by procman

Both modes expose the same tools (`demo.set_message`, `demo.get_message`) and serve an HTML page showing the current message.

## Plugin Mode

Add the plugin to your configuration file:

```json
{
  "plugins": [{ "package": "@shoggoth/service-demo" }]
}
```

The daemon loads the plugin at startup and registers the service + tools automatically.

## Managed Service Mode

Run standalone:

```bash
npm start
# or: npx tsx src/server.ts
```

Environment variables:

| Variable            | Default     | Description      |
| ------------------- | ----------- | ---------------- |
| `DEMO_SERVICE_PORT` | `3200`      | HTTP listen port |
| `DEMO_SERVICE_HOST` | `127.0.0.1` | Bind address     |

You can also pass the port as a CLI argument: `npx tsx src/server.ts 4000`

### Endpoints

| Method | Path               | Description                                  |
| ------ | ------------------ | -------------------------------------------- |
| GET    | `/`                | HTML page showing the current message        |
| GET    | `/manifest`        | Service manifest for Shoggoth discovery      |
| POST   | `/api/set_message` | Set the message (body: `{"message": "..."}`) |
| GET    | `/api/get_message` | Get the current message                      |

### Example procman config

```json
{
  "processes": [
    {
      "id": "demo",
      "startPolicy": "boot",
      "command": "npx",
      "args": ["tsx", "packages/service-demo/src/server.ts"],
      "service": {
        "port": 3200,
        "protocol": "http",
        "basePath": "/",
        "manifestPath": "/manifest",
        "capabilities": ["demo"],
        "expose": "gateway"
      }
    }
  ]
}
```

The daemon will start the process, poll `/manifest` for tool declarations, health-check it, and register the tools once healthy.
