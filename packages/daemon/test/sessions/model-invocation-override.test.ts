/**
 * RED tests for `modelInvocationOverride` threading in `executeSessionAgentTurn`.
 *
 * `ExecuteSessionAgentTurnInput` does not yet have a `modelInvocationOverride`
 * field (Phase 1 of the structured-output OOB delivery plan). These tests call
 * `executeSessionAgentTurn` with the override provided via `as any` and assert
 * that the override fields are merged (with override precedence) into the model
 * invocation params forwarded to the model client's `completeWithTools`.
 *
 * Because the merge is not implemented yet, the responseSchema / structuredOutputMode
 * assertions below FAIL — that is the intended RED state.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_HITL_CONFIG, defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createHitlPendingResolutionStack } from "../../src/hitl/hitl-pending-stack";
import { createPolicyEngine } from "../../src/policy/engine";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop } from "../../src/sessions/tool-loop";
import { closeTestDb } from "../helpers/close-test-db";

const SESSION_SCHEMA = { type: "object", properties: { reply: { type: "string" } } };
const OVERRIDE_SCHEMA = {
  type: "object",
  properties: { to_operator: { type: ["string", "null"] } },
  required: ["to_operator"],
  additionalProperties: false,
};

describe(
  "executeSessionAgentTurn — modelInvocationOverride merging",
  { concurrency: false },
  () => {
    let db: Database.Database;
    let tmp: string;

    function makeHitl() {
      const hitlStack = createHitlPendingResolutionStack(db);
      return {
        bypassUpTo: "safe" as const,
        pending: hitlStack.pending,
        clock: { nowMs: () => Date.now() },
        newPendingId: () => randomUUID(),
        waitForHitlResolution: hitlStack.waitForHitlResolution,
      };
    }

    function stubToolClient(capture: (input: Record<string, unknown>) => void) {
      return {
        async completeWithTools(input: Record<string, unknown>) {
          capture(input);
          return {
            content: "OVERRIDE_TEST_REPLY",
            toolCalls: [],
            usedProviderId: "provA",
            usedModel: "modelA",
            degraded: false,
          };
        },
      };
    }

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "shoggoth-override-"));
      const dbPath = join(tmp, "s.db");
      db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      migrate(db, defaultMigrationsDir());
      createSessionStore(db).create({
        id: "sess-ov",
        workspacePath: tmp,
        systemContextToken: "test-token",
      });
    });

    afterEach(async () => {
      await closeTestDb(db, tmp);
    });

    function baseConfig() {
      const config = defaultConfig(tmp);
      config.models = {
        providers: [
          {
            id: "provA",
            kind: "openai-compatible" as const,
            baseUrl: "http://localhost:1/v1",
            apiKey: "k",
          },
        ],
        failoverChain: [{ providerId: "provA", model: "modelA" }],
        defaultInvocation: { temperature: 0.4, maxOutputTokens: 300 },
      };
      return config;
    }

    async function runTurn(
      config: ReturnType<typeof baseConfig>,
      modelInvocationOverride: Record<string, unknown> | undefined,
      capture: (args: Record<string, unknown>) => void,
    ) {
      const sessions = createSessionStore(db);
      const session = sessions.getById("sess-ov")!;
      await executeSessionAgentTurn({
        db,
        sessionId: "sess-ov",
        session,
        transcript: createTranscriptStore(db),
        toolRuns: createToolRunStore(db),
        userContent: "merge override test",
        userMetadata: undefined,
        env: process.env,
        config,
        policyEngine: createPolicyEngine(config.policy),
        getHitlConfig: () => ({ ...DEFAULT_HITL_CONFIG, ...config.hitl }),
        hitl: makeHitl(),
        loopImpl: runToolLoop,
        createToolCallingClient: () => stubToolClient(capture),
        resolveMcpContext: async () => buildBuiltinOnlySessionMcpToolContext(),
        modelInvocationOverride,
      } as never);
    }

    it("merges modelInvocationOverride fields into the model invocation params", async () => {
      const config = baseConfig();
      // Session sets a temperature via modelSelection; override adds structured output.
      createSessionStore(db).update("sess-ov", {
        modelSelection: { temperature: 0.7 },
      });

      const calls: Record<string, unknown>[] = [];
      await runTurn(
        config,
        {
          responseSchema: { schema: OVERRIDE_SCHEMA },
          structuredOutputMode: "best-effort",
        },
        (args) => calls.push(args),
      );

      assert.ok(calls.length > 0, "completeWithTools should have been called");
      const args = calls[0]!;
      // Override-provided fields reach the model client.
      assert.deepStrictEqual(args.responseSchema, { schema: OVERRIDE_SCHEMA });
      assert.strictEqual(args.structuredOutputMode, "best-effort");
      // Non-overridden session/model defaults are preserved.
      assert.strictEqual(args.temperature, 0.7);
      assert.strictEqual(args.maxOutputTokens, 300);
    });

    it("leaves existing behavior unchanged when no override is provided", async () => {
      const config = baseConfig();

      const calls: Record<string, unknown>[] = [];
      await runTurn(config, undefined, (args) => calls.push(args));

      assert.ok(calls.length > 0, "completeWithTools should have been called");
      const args = calls[0]!;
      // No override → no responseSchema / structuredOutputMode injected.
      assert.strictEqual(args.responseSchema, undefined);
      assert.strictEqual(args.structuredOutputMode, undefined);
      // Session/config defaults survive unchanged.
      assert.strictEqual(args.temperature, 0.4);
      assert.strictEqual(args.maxOutputTokens, 300);
    });

    it("override fields take precedence over session default invocation params", async () => {
      const config = baseConfig();
      // Session (or config default) already sets a response schema + mode.
      config.models!.defaultInvocation = {
        responseSchema: { schema: SESSION_SCHEMA },
        structuredOutputMode: "strict",
        temperature: 0.2,
      };

      const calls: Record<string, unknown>[] = [];
      await runTurn(
        config,
        {
          responseSchema: { schema: OVERRIDE_SCHEMA },
          structuredOutputMode: "best-effort",
        },
        (args) => calls.push(args),
      );

      assert.ok(calls.length > 0, "completeWithTools should have been called");
      const args = calls[0]!;
      // Override wins for the fields it sets…
      assert.deepStrictEqual(args.responseSchema, { schema: OVERRIDE_SCHEMA });
      assert.strictEqual(args.structuredOutputMode, "best-effort");
      // …while un-overridden fields still come from the session defaults.
      assert.strictEqual(args.temperature, 0.2);
    });

    it("does not mutate the session's stored modelSelection when overriding", async () => {
      const config = baseConfig();
      createSessionStore(db).update("sess-ov", {
        modelSelection: { temperature: 0.7 },
      });

      const calls: Record<string, unknown>[] = [];
      await runTurn(
        config,
        {
          responseSchema: { schema: OVERRIDE_SCHEMA },
          structuredOutputMode: "best-effort",
        },
        (args) => calls.push(args),
      );

      assert.ok(calls.length > 0);
      const row = createSessionStore(db).getById("sess-ov")!;
      assert.deepStrictEqual(row.modelSelection, { temperature: 0.7 });
    });
  },
);
