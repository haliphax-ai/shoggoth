# Release checklist - Shoggoth

Use before tagging or shipping a new image.

## Pre-release

- [ ] **Changelog** or release notes summarize user-visible behavior and security fixes.
- [ ] **State DB:** if `migrations/0001_initial.sql` changed this release, operators must **wipe** the SQLite file / state volume (no in-place upgrade).
- [ ] **Breaking config keys:** list any removed or renamed keys in layered JSON / `config.d`; provide before/after examples.
- [ ] **CI green:** unit tests plus **agent UID isolation** job (`SHOGGOTH_CI_STRICT_AGENT_TESTS=1` for `@shoggoth/os-exec`, root container, users aligned with `Dockerfile` build args `SHOGGOTH_UID`/`AGENT_UID`).
- [ ] **Image:** build production image; verify non-root `shoggoth` user and `agent` user exist as in `Dockerfile` (defaults: `SHOGGOTH_UID=1000`, `AGENT_UID=900`).

## Post-release

- [ ] Monitor first deploy for SQLite busy errors and heartbeat lag.
- [ ] Confirm audit logging volume and retention still match policy.

## Dependency: sessions and tool loop

- Session manager / tool loop should be stable before treating this checklist as complete for a "v1" cut; MCP/ACP integration (acpx lifecycle) may add further release steps.
