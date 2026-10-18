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
  on silently wrong lines. `builtin-write` and other writer paths remain outside this legacy
  gate unless separately integrated.
- **All-or-nothing per file.** Any flagged shift blocks edits anywhere in the file, even to
  regions the agent demonstrably re-read.
- **Per-session only.** Two agents (subagents, parallel workflow lanes) racing on one file
  clobber each other without any detection at all.

Hashline mode — modeled on the `pi-hashline-edit-pro` plugin's paradigm (see
[References](#references)) — derives compact anchors deterministically for a file snapshot, then validates edits against
the exact served content and row identity. Staleness becomes per-range and self-healing (the
error returns fresh data needed to retry). Duplicate-line and concurrency ambiguity fails
closed rather than being assumed safe.

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

`builtin-read` in hashline mode prefixes each returned line with a compact content-derived
anchor: `XK7QM2│line text` (uppercase RFC 4648 base32 alphabet `A-Z2-7`). Anchors are
snapshot locators, not globally stable line identities: repeated canonical lines and edits to
their neighborhood can change collision assignments. The served map also records exact line
checksums, duplicate occurrence ordinals, and local identity fingerprints; ambiguous identity
is rejected rather than guessed. The compact anchor canonicalization is only for display and
allocation; verification hashes the full decoded line, including trailing whitespace.

The proof-of-read guarantee covers destructive `builtin-replace` operations only. `builtin-write`,
`builtin-exec`, and external writers are separate mutation paths unless explicitly routed through
the same coordination layer. Hashline handlers serialize their own read/verify/write sequence
per canonical path and recheck before atomic replacement; this cannot eliminate races with
non-cooperating external writers without filesystem compare-and-swap support.

Full allocation/verification semantics: [`spec.md`](spec.md#anchors).

### Served map (proof of read)

A successful text `builtin-read` in hashline mode records only rows actually rendered to the
model as `(session, context segment, canonical workspace-relative path, anchor → exact line
checksum + identity fingerprint)` in `served_hashes`. Truncated-away rows, notices, stat results,
and image payloads do not grant edit authority. Use the same normalized path form for read and
replace. Clear rows on context-segment new/reset and session deletion/retirement. This proof-of-read
guarantee does not automatically cover other mutation tools.

### Edit resolution and verification

At apply time, `builtin-replace` resolves `start`/`end` against the current file and verifies
that every destructive target row was served and its complete content and snapshot identity
still match. Deletions verify every covered line, not just endpoints, so newly inserted interior
content cannot be silently removed. The read/verify/write sequence is serialized among hashline
handlers for each canonical path; recheck the snapshot immediately before atomic replacement.
External, non-cooperating writers remain a documented residual race without filesystem CAS.
Errors are returned in layers:

1. **`[E_STALE_ANCHOR]`** — an anchor no longer exists in the file. The error embeds fresh
   anchor rows around the surviving bound so the agent retries without a full re-read.
2. **`[E_RANGE_STALE]`** — anchors resolve, but lines inside the range no longer match what
   this session was served (the agent was about to overwrite unseen content). The error
   returns the current range with fresh anchors.
3. **Auto-fixable slips** are stripped with `[W_*]` warnings (pasted `anchor│` prefixes,
   diff-marker rows); reversed bounds are swapped; no-op edits (replacement identical to
   current content) short-circuit without writing.

Edits by other sessions to non-overlapping regions should not block: resolution is against live
content and verification is per-range. Changes to the target rows, their duplicate identity, or
context required to disambiguate them fail closed and require fresh rows.

### Result payload

After a successful write, compute returned `live_anchors` from the post-write content and
include the live rows for the changed window, so the agent can chain edits without re-reading.
Never format the result from pre-edit line/anchor buffers. `changed_lines` retains its current
meaning.

### Regex/pattern mode under hashline

`pattern`/`replacement` remains available in both modes. In hashline mode, every complete
matched row must be served and its full content verified before replacement. Reject multiline
matches spanning partial/unserved rows unless exact span-to-row verification is specified;
include fixed-string and multiline cases in tests. This remains a `builtin-replace` guarantee.

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
- **Handler integration (both modes):** batch, positional, regex/fixed-string, dryRun, and
  error payloads; read result shapes and truncation registration; canonical paths; fresh post-write
  live rows. Include same-path concurrent handlers, duplicate-line insert/delete ambiguity,
  interior insertion in a deletion, trailing-space-only changes, changed long-line suffixes,
  EOL/final-newline preservation, and multiline matches. Line-number regression suite stays green.
- **Mode hint:** emitted on first turn of session; re-emitted for every session on new boot
  id; not repeated on subsequent turns of the same boot.
- **Config:** default resolves to `line-number`; restart-required enforcement.
- **Migration:** fresh DB and existing-DB upgrade paths apply cleanly.

## Considerations

- **Token overhead:** ~7 chars per returned row in hashline mode. Windowed reads bound it;
  only rows actually emitted into the model-visible result are registered as served. Define
  behavior for full, ranged, multi-file, truncated, stat, and image reads. Metadata and image
  results do not authorize line edits.
- **Line endings:** preserve untouched original separators and final-newline state. Specify the
  separator inherited by inserted/replacement rows; never normalize the entire file.
- **Deferred to a future plan:** undo slot (`undo_last_change` equivalent), same-message
  batching of same-file edits, `replace_match`-style sub-line editing, anchor-stability
  carry-across-edits (v1 rehashes the file after each edit; the content-checksum cache keeps
  this cheap), anchor-only path resolution.
- **File caps:** a max-lines bound for hashline mode exists by design; large-file editing
  stays in line-number mode's territory or falls back to `builtin-write`. Enforce the line cap
  before emitting/registering rows and use a hard byte cap on hashing/output work as well; do not
  silently authorize rows hidden by truncation.
- **Schema rendering source:** `builtin-shoggoth-tools.ts` must learn the effective mode at
  schema-build time; the wiring mechanism (config plumbed into the mcp-integration schema
  builder) is the main integration unknown and is called out in its implementation phase.

## Migration

Additive only. Two new tables (`served_hashes`, `file_edit_mode_hint`) using migration versions `0024` and
`0025` respectively (the repository already has migrations through `0023`); confirm latest
migration numbering at implementation time. No changes to
`re_read_required` or existing tables; no config changes required to keep current behavior
(`fileEditing` defaults to `line-number`). Existing sessions and workflows are unaffected
until an operator flips the mode and restarts the daemon.

## Review addendum (2026-10-18)

This addendum records review-driven refinements to the original proposal; where wording above
conflicts, this addendum and the detailed contracts in `spec.md`/`implementation.md` govern.

- Assign served-map and hint-table migrations `0024` and `0025` respectively; repository
  migrations already occupy versions through `0023` at review time. Recheck before implementation.
- Separate lossy anchor canonicalization from verification of complete line content. Treat
  anchors as snapshot locators, fail closed on duplicate-line/context ambiguity, and verify every
  row in destructive ranges (including deletion interiors).
- Serialize hashline handler read/verify/write per canonical path, recheck before atomic replace,
  and state the remaining race with non-cooperating writers. The proof-of-read guarantee is for
  hashline `builtin-replace` only unless other writers are explicitly integrated.
- Register only model-visible read rows; define behavior for ranged, multi-file, truncated,
  stat, image, and empty-file reads. Return anchors computed from post-edit content and preserve
  untouched line separators and final-newline state.
- Thread effective mode through MCP catalog and handler construction, rather than assuming
  schemas are rebuilt on each turn. Corrected examples use only `A-Z2-7` anchor characters.

## References

- Upstream paradigm: `YuGiMob/pi-hashline-edit-pro` (MIT) — hashline plugin for the pi
  coding-agent harness; algorithm studied 2026-10-10, adapted (not vendored).
- [`spec.md`](spec.md) — types, schemas, error formats, hash algorithm contract
- [`implementation.md`](implementation.md) — phased implementation steps
- `packages/daemon/src/sessions/re-read-required.ts`, `system-gates.ts`,
  `builtin-handlers/replace-handler.ts` — current gating seams
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — builtin tool schema source
- `packages/daemon/src/sessions/session-system-prompt.ts` — runtime summary / hint seam
