# Shoggoth

TypeScript monorepo for the **daemon** and **operator CLI**, with Docker/Compose and a layered JSON config loader.

## Monorepo layout

| Package            | Role                                                |
| ------------------ | --------------------------------------------------- |
| `@shoggoth/shared` | Config schema (Zod), path constants, `VERSION`, loader |
| `@shoggoth/daemon` | Long-lived process entry (loads config, stays up) |
| `@shoggoth/cli`    | Operator CLI; `shoggoth --version`                  |

**Tooling:** npm workspaces, TypeScript 5.x, Node 22+ (see root `engines`). Each package compiles **`src/` → `dist/`** with `tsc`; a post-step **`scripts/fix-dist-esm-imports.mjs`** appends `.js` on relative specifiers so Node ESM can load the output. **Tests** live under **`test/`** (or package-local `test/`) and run with **`tsx`** (`node --import tsx/esm --test …`). **Sources** use extensionless relative imports (e.g. `./module`, not `./module.js`).

## Filesystem layout (container)

| Path                               | Owner           | Mode (entrypoint) | Notes                                      |
| ---------------------------------- | --------------- | ----------------- | ------------------------------------------ |
| `/etc/shoggoth/config.d`           | shoggoth        | 0750              | Layered `*.json`, sorted by filename       |
| `/var/lib/shoggoth/state`          | shoggoth        | 0700              | SQLite and daemon state                    |
| `/var/lib/shoggoth/operator`       | shoggoth        | 0700              | Operator-only files (e.g. copies of Compose secrets); not agent-readable |
| `/var/lib/shoggoth/workspaces`     | shoggoth:agent  | 0770              | Session roots; traversable by agent GID for session subtrees; not `shoggoth`-only secrets |
| `/var/lib/shoggoth/media/inbound`  | shoggoth        | 0750              | Inbound media                              |
| `/run/shoggoth`                    | shoggoth        | 0750              | Control socket directory                   |
| `/run/secrets`                     | root            | 0700              | Docker secrets; entrypoint never loosens     |

Users: **`shoggoth`** (daemon), **`agent`** (worker pool UID 901) — see `Dockerfile`.

## Config

- Defaults are compiled into `@shoggoth/shared` (see `defaultConfig()`).
- Optional directory overlay: every `*.json` file merged in **ascending lexical order** by basename.
- Override directory with `SHOGGOTH_CONFIG_DIR`.
- Unknown keys are rejected (strict schema).
- Optional **`retention`** block: inbound media age/size and transcript age / per-session message cap. Operator scheduling: `shoggoth retention run`.
- Optional **`models`** block: OpenAI-compatible providers, ordered failover chain, transcript compaction policy. See [docs/models.md](./docs/models.md).
- **Canvas / A2UI:** authorize present/push against the daemon before mutating UI; see [docs/canvas.md](./docs/canvas.md).

## Secrets and SOPS (operators)

See [docs/operator-secrets.md](./docs/operator-secrets.md) for Compose secret mounts, ownership vs agent UIDs, and an optional SOPS decrypt-at-entrypoint workflow.

## Commands

```bash
npm ci
npm run build   # authn native addon + `tsc --noEmit` in every workspace (no emit; runtime is tsx + src/*.ts)
npm run typecheck   # same typecheck step alone, if native already built
npm run cli -- --version
npm run cli -- config-show
npm run cli -- retention run
npm run cli -- session compact <sessionId> [--force]
# or: npx shoggoth --version
```

## Docker

```bash
docker compose build
docker compose up
```

The daemon runs as **`shoggoth`** after `entrypoint.sh` creates layout and drops privileges with `setpriv` (with `cap_add: SETUID, SETGID` in Compose so builtins can spawn agent subprocesses).

The image installs **`/usr/local/bin/shoggoth`** on `PATH`. The wrapper `cd`s **`/app`** before loading `tsx`, so it works even when the caller’s cwd is a session workspace (e.g. `docker compose exec -u agent -w /var/lib/shoggoth/workspaces/... <service> shoggoth --version`).
