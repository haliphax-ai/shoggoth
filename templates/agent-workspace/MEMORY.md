# MEMORY.md

Telling the operator "I'll remember that for next time" is **not sufficient**! You will NOT remember anything outside of your current session transcript UNLESS you write it to memory--this means writing to daily logs **as you work** to be indexed for retrieval later.

Files:

- **Daily log:** `memory/YYYY-MM-DD.md` - primary memory. Write details here as you work.
- **This file:** critical long-term reminders only (key decisions, architecture, open threads). Don't duplicate daily log content here. Don't put project-specific memories here unless it's a long-standing project.

---

## Behavioral Notes

- **NEVER kill a subagent and do the work yourself.** The purpose of delegation is to keep context clear. If a subagent seems stuck, STEER it with more specific instructions. Killing + manual work defeats the purpose and burns context (7 compactions = unacceptable).
- **NEVER block on subagents.** Spawn them, set a timer to check in, move on. No blocking waits.
- **Workspace paths matter.** Memory files go in `/var/lib/shoggoth/workspaces/developer/memory/`. Tmp files go in `/var/lib/shoggoth/workspaces/developer/tmp/`. Do NOT write these to the project repo (`projects/shoggoth/memory/` or `projects/shoggoth/tmp/`). The workspace root and the project root are different directories.
- **Subagents should NOT use `builtin-exec` when builtin tools can do the job.** Exec triggers HITL approval. Only use exec for running tests, typecheck, and git commands. Explicitly state this in task prompts.
- **NEVER use `bash` or `sh` as the exec target.** Not for chaining commands. Not for convenience. Not for git. Each `git` command is a separate `builtin-exec` call with `argv: ["git", ...]`. `bash` is a security boundary violation — it bypasses all the guardrails that the builtin tools provide. This is non-negotiable.
- **Subagents need explicit project paths.** The Shoggoth project lives at `projects/shoggoth/` relative to the workspace root. Subagents don't know this — always include the full relative path in task prompts.
- **`--no-verify` is NEVER acceptable.** If git hooks fail, the subagent must STOP and report the failure to the parent. Never bypass hooks.
- **Kanban cards are ephemeral; the work is the standing record.** (haliphax, 2026-10-05) Never let card details leak into code, comments, commit messages, or PR titles/bodies — no "F11"-style card labels, card IDs, "Finding N", or research-doc provenance. The reverse direction (card → PR link) is fine. Subagent briefs must include this rule explicitly.
- **Verify "unused/dead code" claims with a broad cross-package search.** A subagent that narrowly confirms the original finding's framing produces needless changes (card #14, 2026-09-30: doc added to `ExtensionFlags.threads` that was real noise — closed Won't do). Search wider than the file/finding that raised the issue before deciding remove vs. keep.

## Shoggoth test Discord bot

- Name: `Shoggoth TEST`
- User ID: `1491822453301706883`
- Channel ID: `1491824543705337988`
