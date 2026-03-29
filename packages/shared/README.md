# `@shoggoth/shared`

Layered configuration, Zod schemas, path layout defaults, and shared types for the Shoggoth monorepo.

- **Source:** `src/`
- **Tests:** `test/` (documentation only — no test files; see `test/README.md`)
- **Typecheck:** `npm run typecheck` → `tsc --noEmit` (no emit). Runtime: `tsx` loads `src/*.ts` (repo root `package.json`).

Behavior is covered indirectly through packages that depend on this library.
