import assert from "node:assert/strict";
import { describe, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../../daemon/test/helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyHitlDiscordReaction,
  handleDiscordHitlReactionAdd,
} from "../src/hitl/reaction-handler";
import { createHitlDiscordNoticeRegistry } from "../src/hitl/notice-registry";
import {
  createPendingActionsStore,
  defaultMigrationsDir,
  migrate,
  createLogger,
  createHitlAutoApproveGate,
} from "@shoggoth/daemon/lib";

describe("classifyHitlDiscordReaction", () => {
  it("classifies unicode HITL emojis", () => {
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "1️⃣" }), "once");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "✅" }), "session");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "♾️" }), "agent");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "♾" }), "agent");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "\u267E" }), "agent");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "\u267E\uFE0F" }), "agent");
    assert.equal(classifyHitlDiscordReaction({ id: null, name: "❌" }), "deny");
  });

  it("ignores custom emoji", () => {
    assert.equal(classifyHitlDiscordReaction({ id: "123", name: "x" }), null);
  });
});

describe("handleDiscordHitlReactionAdd", () => {
  it("approve-once resolves pending for owner only", () => {
    const tmp = mkdtempSync(join(tmpdir(), "shoggoth-hitl-react-"));
    const db = new Database(join(tmp, "s.db"));
    try {
      db.pragma("foreign_keys = ON");
      migrate(db, defaultMigrationsDir());
      const pending = createPendingActionsStore(db);
      const id = "pend-r1";
      pending.enqueue({
        id,
        sessionId: "agent:main:discord:channel:10000000-0000-4000-8000-000000000001",
        toolName: "builtin-write",
        payload: {},
        riskTier: "caution",
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
      });
      const registry = createHitlDiscordNoticeRegistry();
      registry.register(
        "ch99",
        "msg99",
        id,
        "agent:main:discord:channel:10000000-0000-4000-8000-000000000001",
        "builtin-write",
      );
      const autoApprove = createHitlAutoApproveGate();
      const log = createLogger({ component: "t", minLevel: "error" });
      handleDiscordHitlReactionAdd({
        ev: {
          kind: "message_reaction_add",
          userId: "owner-snow",
          channelId: "ch99",
          messageId: "msg99",
          emoji: { id: null, name: "1️⃣" },
        },
        pending,
        registry,
        autoApprove,
        ownerUserId: "owner-snow",
        botUserIdRef: { current: "bot-snow" },
        logger: log,
      });
      assert.equal(pending.getById(id)!.status, "approved");

      handleDiscordHitlReactionAdd({
        ev: {
          kind: "message_reaction_add",
          userId: "stranger",
          channelId: "ch99",
          messageId: "msg99",
          emoji: { id: null, name: "❌" },
        },
        pending,
        registry,
        autoApprove,
        ownerUserId: "owner-snow",
        botUserIdRef: { current: "bot-snow" },
        logger: log,
      });
      assert.equal(pending.getById(id)!.status, "approved");
    } finally {
      closeTestDb(db, tmp);
    }
  });
});
