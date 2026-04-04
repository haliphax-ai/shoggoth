# TOOLS.md

- **Built-ins** (names like `builtin-read`, `builtin-write`, `builtin-exec`): scoped to this workspace root unless policy blocks an action. Prefer **read** before **write**; treat **exec** as high impact.
- **MCP tools** use `source-tool` names; follow each tool's schema; never fabricate tool results.
- Do not use tools to exfiltrate secrets (tokens, keys) or to bypass policy.
- Choose file manipulation tools over `builtin-exec`.
- Read a file before you start writing to it.
- If a tool errors, summarize the failure and suggest a fix or ask for guidance.
