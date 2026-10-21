# Config & HITL Merge TUI

`shoggoth-config-merge` selectively folds the dynamic configuration fragments and the
persisted HITL tool auto-approvals that agents accumulate at runtime back into the
operator-managed **base** configuration.

At runtime the daemon loads configuration from every `*.json` it finds under the config
directory in ascending full-path order (see [Shared — Layered configuration](shared.md)).
Two producers drop fragments into the daemon-writable **dynamic** directory:

- the `config_request` control op / `builtin-config-request` tool (per-key config changes), and
- the HITL persistence layer (`z-hitl-agent-tool-auto-approve.json`, the ♾️ auto-approve list).

Those fragments keep applying on every boot until they are either merged into base or
deleted. Merging is what makes a change _intentional and permanent_ rather than a
transient runtime override.

The base directory is mounted **read-only** in the running container, so the merge runs in a
separate throwaway container with the base mount flipped to read-write. It is a plain
line-at-a-time prompt interface — no alternate screen, no raw-mode terminal handling. The
heavy lifting is done by a throwaway `git` repository, which lets the operator keep or drop
individual hunks with the familiar `git commit -p` prompts.

---

## Invocation

The script is baked into the image as `/usr/local/bin/shoggoth-config-merge` and is meant to
be run as the entrypoint of a throwaway container:

```sh
docker run --rm -it \
  --entrypoint /usr/local/bin/shoggoth-config-merge \
  -v "$PWD/config/base:/etc/shoggoth/config.d/base" \
  -v "$PWD/config/dynamic:/etc/shoggoth/config.d/dynamic:ro" \
  shoggoth:local \
  config
```

Use `hitl` instead of `config` to merge only the persisted HITL approvals.

| Piece         | Requirement                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `-it`         | Required. The `git commit -p` prompts read from the terminal.                                             |
| base mount    | **Read-write** (default). This is the directory that gets modified.                                       |
| dynamic mount | **Read-only** (`:ro`). The script only ever reads fragments.                                              |
| `--rm`        | Recommended. The container is disposable; the temp repo lives in the container's `/tmp` and dies with it. |

The image's own `ENTRYPOINT`/`CMD` are bypassed by `--entrypoint`, so the daemon does not
start — this container only performs the merge.

### Actions

| Action   | Sources merged                                                                           | Typical use                                                                            |
| -------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `config` | Every `*.json` in the dynamic directory **except** `z-hitl-agent-tool-auto-approve.json` | Promote config changes requested via `config_request` / `builtin-config-request`.      |
| `hitl`   | Only `z-hitl-agent-tool-auto-approve.json`                                               | Promote the ♾️ tool auto-approve list into `agents.<id>.hitl.toolAutoApprove` in base. |

Keeping the two separate matters because they have different risk profiles: a HITL approval
loosens a safety gate, whereas a config fragment is usually a tuning change. Splitting them
lets an operator promote one class without wading through the other's hunks.

### Environment

| Variable                      | Default                          | Purpose                                    |
| ----------------------------- | -------------------------------- | ------------------------------------------ |
| `SHOGGOTH_BASE_CONFIG_DIR`    | `/etc/shoggoth/config.d/base`    | Base configuration directory (read-write). |
| `SHOGGOTH_DYNAMIC_CONFIG_DIR` | `/etc/shoggoth/config.d/dynamic` | Dynamic fragment directory (read-only).    |

### Exit codes

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | Success, or a clean no-op (nothing to merge, or the operator declined every hunk). |
| `1`  | Environment error — a required tool (`git`, `jq`) or directory is missing.         |
| `2`  | Usage error — missing or unrecognized action.                                      |
| `3`  | Interrupted by a signal.                                                           |

A run that declines every hunk exits `0` on purpose: it is a valid outcome, not a failure,
so it should not trip automation that guards the merge step.

---

## How a fragment is routed

Each top-level key in a fragment is called a **top-most parent property**. Routing is
per-property, so a fragment holding several unrelated keys can land in several base files:

1. For a given property, scan base files in ascending full-path order (recursive) and pick
   the **first** file whose top-level object already contains that property.
2. If no file contains it, create `<property name>.json` at the base root.
3. Merge the property's value into the target using the same semantics the daemon applies at
   runtime: objects merge recursively, arrays and scalars are replaced, and the incoming
   fragment wins on conflict.

Agent-mergeable collections (`mcp.servers`, `models.providers`, `mediaGeneration.providers`,
`decision.providers`, `rerank.providers`) are keyed objects — provider/server id → config block —
so a fragment that adds or overrides one entry deep-merges by id instead of replacing the whole
list. Leave the id out of the value; it is the property key. The same applies one level down:
each provider's `models` list is also a keyed record — model name → model config
(`models.providers.<id>.models.<name>`, likewise for `mediaGeneration`/`decision`/`rerank`
providers) — so a fragment that adds or overrides one model deep-merges by model name instead
of replacing the whole array.

Because routing is "first file that already has the key", adding a key to a file that sorts
later will not steal it from an earlier file that owns it — matching the runtime load order,
where the earlier file is read first.

---

## What the session looks like

The script prints a routing plan and asks for confirmation before touching anything:

```
Merge plan (config):
  memory.json [memory] -> memory.json (new file)
  agents.json [agents] -> 10-agents.json

Proceed with interactive merge? [y/N] y
```

Confirming opens the standard `git commit -p` hunk prompts. Each hunk is one property's
worth of change; answer `y` to keep it, `n` to drop it, `q` to stop staging:

```
diff --git a/10-agents.json b/10-agents.json
@@ -12,6 +12,9 @@
   "agents": {
     "list": {
       "main": {
+        "hitl": {
+          "toolAutoApprove": ["gh", "jq"]
+        }
(1/1) Stage this hunk [y,n,q,a,d,e,?]? y
```

Anything not committed is discarded. Only committed files are written back.

---

## The throwaway repository

The merge is built on a scratch `git` repo inside the container's `/tmp`:

1. Copy the base configuration in and commit it untouched (`base configuration (untouched)`).
2. For each property, write the reorganized copy of its target file into the working tree.
   New `<property name>.json` files enter the index as intent-to-add (`git add -N`) so their
   content is offered as ordinary unstaged hunks.
3. `git commit -p` lets the operator select hunks interactively.
4. `git reset --hard` + `git clean -qfd` throw away everything that was not committed.
5. For each committed file, the real mounted original is backed up as
   `<file name>.json.<POSIX timestamp>.bak` and the merged version is copied into place.
6. The container exits; `--rm` removes it and the temp repo with it.

Using `git` for selection means the operator gets real diff context and the full hunk
vocabulary (`y`/`n`/`q`/`a`/`d`/`e`/`?`) instead of a bespoke picker.

---

## Backups and rollback

Every file that is replaced gets a sibling backup named `<file name>.json.<POSIX
timestamp>.bak` — for example `10-agents.json.1793011200.bak`. Files that were only added
have no original to back up.

Backups are written next to the live config, so they are inside the base mount and survive
the throwaway container. Roll back by restoring a backup:

```sh
mv config/base/10-agents.json.1793011200.bak config/base/10-agents.json
```

The `.bak` suffix keeps them from being picked up by the config loader, which only reads
`*.json`. They are not auto-pruned; remove stale ones as part of your own housekeeping.

Note that the merge does **not** delete the dynamic fragments. After a successful merge the
same values are applied twice (once from base, once from dynamic), which is harmless because
the merge is idempotent. Delete a fragment from the dynamic directory once you are satisfied
with the merged base configuration — restart the daemon to have it pick up the change.

---

## Requirements and caveats

- `git` and `jq` must be on the image. Both are already installed in the Shoggoth runtime
  image.
- The base directory must exist and be mounted read-write; the dynamic directory must exist.
  Either being missing is a hard error (exit `1`).
- The script does not validate fragments against the config schema — it trusts the fragments
  the daemon already wrote. A malformed fragment is reported as a warning and skipped, and
  does not stop the rest of the merge.
- Run one merge at a time. Concurrent runs against the same base directory would race on the
  backup and copy-back step.

---

## Related

- [Shared — Layered configuration](shared.md) — load order and merge semantics.
- [Daemon — Control plane](daemon.md) — the `config_request` op that writes dynamic fragments.
- [CLI reference](cli.md) — `shoggoth config show --dynamic` to inspect pending fragments.
