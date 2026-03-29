import { describe, it } from "node:test";
import assert from "node:assert";
import { discordCapabilityDescriptor } from "../src/capabilities";

describe("Adapter capability descriptor", () => {
  it("advertises Discord v1 extensions and parameter shapes", () => {
    const cap = discordCapabilityDescriptor();
    assert.equal(cap.platform, "discord");
    assert.equal(cap.supports.markdown, true);
    assert.equal(cap.supports.directMessages, true);
    assert.equal(cap.supports.groupChannels, true);
    assert.equal(cap.extensions.attachments, true);
    assert.equal(cap.extensions.threads, true);
    assert.equal(cap.extensions.replies, true);
    assert.equal(cap.extensions.reactionsInbound, true);
    assert.equal(cap.extensions.streamingOutbound, true);
    assert.ok(cap.parameterSchemas.outboundText);
    assert.equal(cap.parameterSchemas.outboundText.type, "object");
    assert.ok(cap.parameterSchemas.attachment);
  });
});
