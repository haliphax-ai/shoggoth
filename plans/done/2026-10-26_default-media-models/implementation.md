# Implementation plan — Default models per media generation type

Red/green TDD per phase: write the failing tests first, run them (red), then
implement (green), then commit.

## Phase 1 — Config schema

Files:

- `packages/shared/src/schema/runtime.ts`
- `packages/daemon/test/media/media-generate-control-op.test.ts` (schema describe block)

Steps:

1. Add schema tests: accepts `defaults` with valid `provider-id/model-id`
   refs; rejects unknown suggestion kinds; rejects refs that match no
   configured model; rejects malformed refs (no slash).
2. Implement `defaults` block + `superRefine` on
   `shoggothMediaGenerationConfigSchema`.
3. Run shared + daemon schema tests, commit.

## Phase 2 — Service-level default resolution

Files:

- `packages/daemon/src/media/media-generation-service.ts`
- `packages/daemon/test/media/media-generation-service.test.ts`

Steps:

1. Tests: generate without `model` uses the kind's default; `speech`/`music`
   fall back to suggestions; error status when neither model nor default
   exists; explicit model still wins over default.
2. Implement `defaults` pass-through (`fromConfig` → constructor) and
   resolution in `generate()`; make `GenerateRequest.model` optional.
3. Run tests, commit.

## Phase 3 — Control op optional model

Files:

- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/test/media/media-generate-control-op.test.ts`

Steps:

1. Tests: op accepts payload without `model` (forwards `undefined`, service
   resolves); op rejects non-string/non-empty `model`; error message when no
   default configured (covered in Phase 2 service test).
2. Change `media_generate` validation: model optional with type check.
3. Run tests, commit.

## Phase 4 — Tool handler + descriptor + CLI

Files:

- `packages/daemon/src/sessions/builtin-handlers/media-generate-handler.ts`
- `packages/daemon/src/sessions/session-mcp-tool-context.ts`
- `packages/daemon/test/sessions/media-generate-tool-finalizer.test.ts`
- `packages/cli/src/run-media.ts`
- `packages/cli/test/run-media.test.ts`

Steps:

1. Descriptor tests: with all three defaults configured, `model` not in
   `required` and description names defaults; with only some defaults,
   `model` stays required; suggestions appear in description.
2. CLI tests: `parseMediaGenerateArgs` accepts missing `--model`; payload
   omits `model` key.
3. Implement: handler drops early model check; descriptor becomes
   `mediaGenerateToolDescriptor(config)` factory; CLI parser optional.
4. Run daemon + cli test suites, commit.

## Phase 5 — Full verification

1. `npx vitest run` at repo root (or package-scoped test scripts).
2. `npx tsc --noEmit` type check.
3. `npx oxlint` / `npx oxfmt` if configured as repo checks (git hooks run
   tests on commit and typecheck on push anyway).
4. Update plan frontmatter `completed` date, move folder to `plans/done/`.
5. Push branch, open PR referencing issue.
