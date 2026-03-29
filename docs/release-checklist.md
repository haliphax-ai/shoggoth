# Release checklist — Shoggoth

Use before tagging or shipping a new image.

## Pre-release

- [ ] **Changelog** or release notes summarize user-visible behavior and security fixes.
- [ ] **Migrations:** all DB migrations from version **N** apply cleanly on a copy of production-like data; note the highest migration id shipped in **N+1**.
- [ ] **Rollback:** document that operators who skip a version may need to restore DB backup if migrations are not reversible; forward-only migrations require backup-before-upgrade.
- [ ] **Breaking config keys:** list any removed or renamed keys in layered JSON / `config.d`; provide before/after examples.
- [ ] **CI green:** unit tests plus **agent UID isolation** job (`SHOGGOTH_CI_STRICT_AGENT_TESTS=1` for `@shoggoth/os-exec`, root container, users **900/901** aligned with `Dockerfile`).
- [ ] **Image:** build production image; verify non-root `shoggoth` user and `agent` uid **901** exist as in `Dockerfile`.

## Post-release

- [ ] Monitor first deploy for SQLite busy errors and heartbeat lag.
- [ ] Confirm audit logging volume and retention still match policy.

## Dependency: sessions and tool loop

- Session manager / tool loop should be stable before treating this checklist as complete for a “v1” cut; MCP/ACP integration (canvas authz, acpx lifecycle) may add further release steps.
