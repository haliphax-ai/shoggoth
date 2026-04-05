import { describe, it } from "vitest";
import assert from "node:assert";
import { executeMessageToolAction, summarizeApiMessage } from "@shoggoth/messaging";
import { executeDiscordMessageToolAction, summarizeDiscordApiMessage } from "../src/message-tool";

describe("platform-discord message-tool re-exports", () => {
  it("executeDiscordMessageToolAction is executeMessageToolAction", () => {
    assert.strictEqual(executeDiscordMessageToolAction, executeMessageToolAction);
  });

  it("summarizeDiscordApiMessage is summarizeApiMessage", () => {
    assert.strictEqual(summarizeDiscordApiMessage, summarizeApiMessage);
  });
});
