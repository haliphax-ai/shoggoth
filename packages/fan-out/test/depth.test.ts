import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canSpawn } from "../src/depth.js";

describe("canSpawn", () => {
  it("allows spawning when depth is below max", () => {
    assert.equal(canSpawn(0, 2), true);
    assert.equal(canSpawn(1, 2), true);
  });

  it("disallows spawning when depth equals max", () => {
    assert.equal(canSpawn(2, 2), false);
  });

  it("disallows spawning when depth exceeds max", () => {
    assert.equal(canSpawn(3, 2), false);
  });

  it("disallows spawning when max is 0", () => {
    assert.equal(canSpawn(0, 0), false);
  });
});
