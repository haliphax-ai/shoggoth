import { describe, it, assert, expect, vi } from "vitest";
import {
  HITL_DISCORD_NOTICE_REACTION_EMOJIS,
  registerDiscordHitlNoticeAndAddReactions,
} from "../src/hitl/reaction-wiring";
import { createHitlDiscordNoticeRegistry } from "../src/hitl/notice-registry";
import type { DiscordRestTransport } from "../src/transport";
import type { Logger, PendingActionRow } from "../src/daemon-types";
import type { HitlRiskTier } from "@shoggoth/shared";

function makeRow(id: string): PendingActionRow {
  return {
    id,
    sessionId: "agent:test:discord:channel:1",
    correlationId: undefined,
    toolName: "builtin-exec",
    resourceSummary: undefined,
    payload: {},
    riskTier: "caution" satisfies HitlRiskTier,
    status: "pending",
    denialReason: undefined,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeLogger() {
  const warnings: unknown[][] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(...args: unknown[]) {
      warnings.push(args);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warnings };
}

/**
 * Transport whose createMessageReaction fails for the given emojis.
 * `hang: true` defers failures until manually rejected (to test parallelism);
 * otherwise failures reject immediately.
 */
function stubTransport(
  failFor: ReadonlySet<string>,
  opts: { readonly hang?: boolean } = {},
): {
  transport: DiscordRestTransport;
  calls: string[];
  deferred: Array<(err?: unknown) => void>;
} {
  const calls: string[] = [];
  const deferred: Array<(err?: unknown) => void> = [];
  const transport = {
    async createMessageReaction(
      _channelId: string,
      _messageId: string,
      emoji: string,
    ): Promise<void> {
      calls.push(emoji);
      if (!failFor.has(emoji)) return;
      if (opts.hang) {
        return new Promise((_resolve, reject) => {
          deferred.push(reject);
        });
      }
      throw new Error("reaction rejected");
    },
  } as unknown as DiscordRestTransport;
  return { transport, calls, deferred };
}

function run(transport: DiscordRestTransport, logger: Logger) {
  return registerDiscordHitlNoticeAndAddReactions({
    transport,
    channelId: "ch1",
    messageId: "msg1",
    row: makeRow("pending-1"),
    registry: createHitlDiscordNoticeRegistry(),
    logger,
  });
}

describe("registerDiscordHitlNoticeAndAddReactions", () => {
  it("registers the notice even when every reaction add fails", async () => {
    const { logger } = makeLogger();
    const { transport } = stubTransport(new Set(HITL_DISCORD_NOTICE_REACTION_EMOJIS));
    const registry = createHitlDiscordNoticeRegistry();

    await expect(
      registerDiscordHitlNoticeAndAddReactions({
        transport,
        channelId: "ch1",
        messageId: "msg1",
        row: makeRow("pending-1"),
        registry,
        logger,
      }),
    ).resolves.toBeUndefined();
    assert.deepEqual(registry.lookup("ch1", "msg1"), {
      pendingId: "pending-1",
      sessionId: "agent:test:discord:channel:1",
      toolName: "builtin-exec",
    });
  });

  it("attempts all reactions in parallel when adds hang, then resolves", async () => {
    const { logger } = makeLogger();
    const { transport, calls, deferred } = stubTransport(
      new Set(HITL_DISCORD_NOTICE_REACTION_EMOJIS),
    );

    const promise = run(transport, logger);
    await vi.waitFor(() => {
      assert.equal(calls.length, HITL_DISCORD_NOTICE_REACTION_EMOJIS.length);
    });

    for (const reject of deferred) reject(new Error("rate limited"));
    await expect(promise).resolves.toBeUndefined();
  });

  it("warns once listing every failed emoji", async () => {
    const { logger, warnings } = makeLogger();
    const failed = ["✅", "❌"];
    const { transport, deferred } = stubTransport(new Set(failed), { hang: true });

    const promise = run(transport, logger);
    await vi.waitFor(() => {
      assert.equal(deferred.length, failed.length);
    });
    for (const reject of deferred) reject(new Error("boom"));
    await expect(promise).resolves.toBeUndefined();

    assert.equal(warnings.length, 1, `expected one warn call, got ${warnings.length}`);
    const [msg, fields] = warnings[0] as [string, { failedEmojis: string[] }];
    assert.equal(msg, "hitl.discord_reactions_failed");
    assert.deepEqual([...fields.failedEmojis].sort(), [...failed].sort());
  });

  it("does not warn when every reaction succeeds", async () => {
    const { logger, warnings } = makeLogger();
    const { transport, calls } = stubTransport(new Set());

    await expect(run(transport, logger)).resolves.toBeUndefined();
    assert.deepEqual(calls, [...HITL_DISCORD_NOTICE_REACTION_EMOJIS]);
    assert.equal(warnings.length, 0);
  });
});
