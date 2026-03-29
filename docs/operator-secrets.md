# Operator guide: secrets mounts and SOPS

This document complements the [filesystem layout](../README.md#filesystem-layout-container) in the main README. It is aimed at **operators** deploying Shoggoth in Docker, not at agent sessions.

## Docker Compose secrets

- **Swarm / Compose secrets** are mounted as files under **`/run/secrets`** (typical pattern). The daemon user should read only the secrets it needs via config (e.g. env vars pointing at file paths).
- **Ownership:** keep secret files **not readable** by the **agent** worker UID/GID (`agent` in the reference image). In practice:
  - Mount secrets with root-owned **`0700`** directories, or
  - Use Compose `secrets` and ensure the **entrypoint** copies or maps them into a path owned by `shoggoth` with **`0640`** and group `shoggoth`, while the `agent` user is not in that group.
- **`/var/lib/shoggoth/operator`** (volume `shoggoth-operator` in Compose): created **0700** `shoggoth:shoggoth` by `docker/entrypoint.sh`. Use for plaintext copies of tokens the daemon must read as user `shoggoth`; the **agent** UID/GID (`901`) is not in group `shoggoth` and cannot traverse `state` / `operator` / socket dirs.
- **`/var/lib/shoggoth/...`** layout: operator-only paths (`state`, `operator`, config overlays that contain sensitive data) must stay **0700** / `shoggoth:shoggoth` as in `docker/entrypoint.sh`. Do not place raw API tokens under **`workspaces`** roots without session-scoped **0700** subdirs.

See commented **`secrets:`** stubs in `docker-compose.yml` for wiring a secret such as `discord_token` into the container; adjust user/copy steps so only the daemon identity can read them.

## Optional SOPS workflow (committed ciphertext)

Use [Mozilla SOPS](https://github.com/getsops/sops) when you want **encrypted JSON (or YAML) in git** and plaintext only inside the running container.

1. **On the operator workstation:** install `sops` and `age` (or PGP). Create an age key; add the public key to `.sops.yaml` in the repo.
2. **Encrypt** a config fragment, e.g. `10-secrets.json` → encrypt to `10-secrets.sops.json` (exact naming is up to you; the loader only merges `*.json` today, so either decrypt before mount or add a decrypt step in the entrypoint).
3. **Recommended pattern for v1:** decrypt at **container start** in a custom entrypoint:
   - Read ciphertext from an image layer or volume (e.g. `/etc/shoggoth/config.d.enc/10-secrets.sops.json`).
   - Decrypt with `SOPS_AGE_KEY_FILE` or mounted key material available only to root during startup.
   - Write plaintext to **`/etc/shoggoth/config.d/`** with mode **`0640`**, owner **`shoggoth`**, then `exec` the normal daemon entrypoint.
4. **Never** commit age private keys or decrypted tokens. Rotate keys by re-encrypting files and rolling the mount.

The Shoggoth config loader does **not** embed SOPS natively; treating decryption as an **operator pre-step** keeps the daemon simpler and avoids embedding crypto policy in-process.

## Retention jobs (related ops)

Inbound media and transcript retention are configured under **`retention`** in layered JSON (see shared schema `shoggothRetentionConfigSchema`). Run:

```bash
shoggoth retention run
```

on a schedule (host cron, systemd timer, or Kubernetes CronJob) using the same image/env as the daemon. Each run appends **`audit_log`** rows with actions `retention.purge_*` and JSON summaries in `args_redacted_json`.
