---
date: 2026-10-10
completed: never
---

# Hashline (Content-Addressed) File Editing Mode

## Summary

Add a globally configured file-editing mode in which `builtin-read` serves per-line content
anchors and `builtin-replace` addresses edits by those anchors, replacing line-count-based
staleness detection with per-range content verification. Line-number mode remains the default;
both modes are permanent, first-class citizens selected by `fileEditing.mode` in config.

## Motivation

Today's staleness defense is the `re-read-required` gate: after a `builtin-replace` whose
edit changed a file's line count, the file is flagged per (session, context segment) and all
further edits to it are blocked until `builtin-read` clears the flag. This is coarse and has
blind spots:

- **Same-line edits are invisible.** Detection compares line counts; a same-count content
  change (another agent rewriting a function in place) never flags, and positional edits land
  on silently wrong lines.
- **All-or-nothing per file.** Any flagged shift blocks edits anywhere in the file, even to
  regions the agent demonstrably re-read.
- **Per-session only.** Two agents (subagents, parallel workflow lanes) racing on one file
  clobber each other without any detection at all.

Hashline mode — modeled on the `pi-hashline-edit-pro` plugin's paradigm (see
[References](#references)) — makes every line's identity a pure function of its content, so
edits are resolved and verified against the file as it exists at apply time. Staleness becomes
per-range, self-healing (the error returns the fresh data needed to retry), and correct across
agents by construction.

## Design

### Mode selection and lifecycle

`fileEditing.mode: "line-number" | "hashline"` in `ShoggothConfig` (default `"line-number"`).
The mode is daemon-global: the file tools are entirely one dialect or the other — never
per-call or per-tool. It is a **restart-required** key (added to `CONFIG_RESTART_REQUIRED_KEYS`)
because it changes tool schemas, prompt guidance, and gate wiring wholesale. There is no
migration between modes; switching the config and restarting is the whole story.

Line-number mode behavior is unchanged and permanent: positional/regex addressing and the
`re-read-required` gate stay fully wired and tested. Hashline mode is purely additive.

### Unified parameter names

Parameter names never differ between modes; only the interpretation (and rendered type) of
values does:

| Parameter                          | line-number mode             | hashline mode                           |
| ---------------------------------- | ---------------------------- | --------------------------------------- |
| `start` / `end`                    | 1-based line numbers         | anchor strings served by `builtin-read` |
| `edits[]` items                    | `{start, end, replacement?}` | same shape, anchor `start`/`end`        |
| `pattern`/`replacement` regex mode | unchanged                    | unchanged (see verification below)      |
| `path`, `dryRun`                   | unchanged                    | unchanged                               |

No mode-exclusive names (`remove_from`/`remove_to`-style) are introduced. The tool schemas
rendered to models differ only in value type/description per mode, from a single source (see
[`spec.md`](spec.md)).

### Anchors

`builtin-read` in hashline mode prefixes each returned line with a content-derived anchor:
`Xk7Qm2│line text`. The anchor is derived deterministically from the canonicalized line
content (CR stripped, trailing whitespace trimmed, length-capped) via `node:crypto` hashing
and a per-file collision probe — no WASM, no external registry, no session state. The same
content produces the same anchor in any session, on any machine, at any time, which is what
makes parallel agents safe without coordination.

Full allocation/verification semantics: [`spec.md`](spec.md#anchors).

### Served map (proof of read)

A successful `builtin-read` in hashline mode records `(session, context segment, path,
anchor → line checksum)` rows in a new `served_hashes` table. `builtin-replace` may only
modify lines whose current content still matches the checksum this session was served —
i.e., an agent can never overwrite content it has not seen. Rows are cleared on context
segment new/reset, exactly like `re_read_required`.

### Edit resolution and verification

At apply time, `builtin-replace` re-hashes the current file, resolves `start`/`end` anchors
to live line numbers, and verifies the served checksums of the target range, in layers:

1. **`[E_STALE_ANCHOR]`** — an anchor no longer exists in the file. The error embeds fresh
   anchor rows around the surviving bound so the agent retries without a full re-read.
2. **`[E_RANGE_STALE]`** — anchors resolve, but lines inside the range no longer match what
   this session was served (the agent was about to overwrite unseen content). The error
   returns the current range with fresh anchors.
3. **Auto-fixable slips** are stripped with `[W_*]` warnings (pasted `anchor│` prefixes,
   diff-marker rows); reversed bounds are swapped; no-op edits (replacement identical to
   current content) short-circuit without writing.

Edits by _other_ sessions to unrelated lines never block: resolution is always against live
content, and the served check is per-range.

### Result payload

After a successful write, the result includes the live anchors for the changed window
(`+anchor│` rows for new/changed lines), so the agent chains consecutive edits without
re-reading. `changed_lines` is returned as today.

### Regex/pattern mode under hashline

`pattern`/`replacement` remains available in both modes. In hashline mode, matched lines are
subject to the same served-checksum verification before replacement — the proof-of-read
invariant holds even for regex edits.

### System-prompt mode hint

Two mechanisms, both driven by the effective config:

1. **Always-on marker:** the runtime summary line (`buildRuntimeSection`) gains
   `file_edit=<mode>`, so the active mode is visible in every system prompt at token cost ~3.
2. **Conditional hint block:** a short explanatory block describing the active mode's contract
   is appended to the system prompt on the **first turn of a session** and on the **first turn
   of every session after a daemon restart** (tracked via a per-daemon `bootId` and a
   `file_edit_mode_hint` state table). This keeps the explanation cheap (once per session/boot)
   while guaranteeing no agent starts a session guessing which dialect the tools speak.

### Re-read gate interplay

In hashline mode the `re-read-required` gate is neither consulted nor produced by
`builtin-replace` — content verification supersedes it for anchor-addressed edits. The gate
code, table, and `system-gates.ts` wiring are untouched and remain line-number mode's primary
defense. `builtin-write` keeps the gate in both modes.

### Security

- Anchors are never a path-resolution mechanism: `path` stays explicit and sandbox-checked as
  today; anchors only address lines within the named file, and an anchor not served for that
  file is rejected.
- The served map is scoped by (session, context segment); no cross-session read leakage.
- Hashline mode enforces file size caps (line count and per-line hash input length) so a
  hostile or pathological file cannot turn reads into a DoS; over-cap files return an error
  directing the agent to `builtin-write`.
- Hashing uses `node:crypto` only — no new runtime dependencies, no WASM.

## Testing Strategy

Red/green TDD per project rules. Vitest throughout.

- **Hashline core (pure unit tests):** deterministic allocation (same content → same
  anchors), collision probing, canonicalization (CRLF, trailing whitespace, long lines),
  resolution after insert/delete/reorder above and within a range, stale-anchor and
  range-stale detection, no-op detection, reversed-bound swap.
- **Served map:** registration on read, verification on replace, clear on segment new/reset,
  rejection of unserved anchors.
- **Handler integration (both modes):** existing `replace-handler`-style tests run under
  `fileEditing.mode: "hashline"` — batch, positional, regex, dryRun, error payloads;
  line-number mode regression suite stays green unchanged.
- **Mode hint:** emitted on first turn of session; re-emitted for every session on new boot
  id; not repeated on subsequent turns of the same boot.
- **Config:** default resolves to `line-number`; restart-required enforcement.
- **Migration:** fresh DB and existing-DB upgrade paths apply cleanly.

## Considerations

- **Token overhead:** ~7 chars per line of read output in hashline mode. Accepted globally
  in exchange for eliminating re-read round trips; windowed reads (`offset`/`limit`) bound it.
- **Mixed line endings:** v1 writes the file's dominant EOL for replaced regions; per-line
  separator fidelity (the plugin's `content_separators` machinery) is deferred — tracked
  below under deferred work.
- **Deferred to a future plan:** undo slot (`undo_last_change` equivalent), same-message
  batching of same-file edits, `replace_match`-style sub-line editing, anchor-stability
  carry-across-edits (v1 rehashes the file after each edit; the content-checksum cache keeps
  this cheap), anchor-only path resolution.
- **File caps:** a max-lines bound for hashline mode exists by design; large-file editing
  stays in line-number mode's territory or falls back to `builtin-write`.
- **Schema rendering source:** `builtin-shoggoth-tools.ts` must learn the effective mode at
  schema-build time; the wiring mechanism (config plumbed into the mcp-integration schema
  builder) is the main integration unknown and is called out in its implementation phase.

## Migration

Additive only. Two new tables (`served_hashes`, `file_edit_mode_hint`); no changes to
`re_read_required` or existing tables; no config changes required to keep current behavior
(`fileEditing` defaults to `line-number`). Existing sessions and workflows are unaffected
until an operator flips the mode and restarts the daemon.

## References

- Upstream paradigm: `YuGiMob/pi-hashline-edit-pro` (MIT) — hashline plugin for the pi
  coding-agent harness; algorithm studied 2026-10-10, adapted (not vendored).
- [`spec.md`](spec.md) — types, schemas, error formats, hash algorithm contract
- [`implementation.md`](implementation.md) — phased implementation steps
- `packages/daemon/src/sessions/re-read-required.ts`, `system-gates.ts`,
  `builtin-handlers/replace-handler.ts` — current gating seams
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — builtin tool schema source
- `packages/daemon/src/sessions/session-system-prompt.ts` — runtime summary / hint seam
