import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanvasAuthorizeLine,
  parseWireResponseLine,
  toAuthorizeHttpBody,
  WIRE_VERSION,
} from "./wire.mjs";

describe("canvas-authorize-hook wire", () => {
  it("buildCanvasAuthorizeLine produces valid envelope", () => {
    const line = buildCanvasAuthorizeLine({
      id: "t1",
      auth: { kind: "agent", session_id: "s1", token: "tok" },
      payload: { action: "canvas.push", resource_session_id: "s1" },
    });
    assert.ok(line.endsWith("\n"));
    const obj = JSON.parse(line.trim());
    assert.equal(obj.v, WIRE_VERSION);
    assert.equal(obj.op, "canvas_authorize");
    assert.equal(obj.id, "t1");
    assert.deepEqual(obj.payload, {
      action: "canvas.push",
      resource_session_id: "s1",
    });
  });

  it("rejects invalid payload", () => {
    assert.throws(() =>
      buildCanvasAuthorizeLine({
        id: "x",
        auth: {},
        payload: { action: "", resource_session_id: "s" },
      }),
    );
  });

  it("parseWireResponseLine and toAuthorizeHttpBody", () => {
    const allow = parseWireResponseLine(
      JSON.stringify({
        v: 1,
        id: "r1",
        ok: true,
        result: { allow: true },
      }),
    );
    assert.deepEqual(toAuthorizeHttpBody(allow), {
      ok: true,
      httpStatus: 200,
      body: { allow: true },
    });

    const deny = parseWireResponseLine(
      JSON.stringify({
        v: 1,
        id: "r2",
        ok: true,
        result: { allow: false, reason: "agent_cannot_touch_foreign_session_canvas" },
      }),
    );
    assert.deepEqual(toAuthorizeHttpBody(deny), {
      ok: true,
      httpStatus: 200,
      body: { allow: false, reason: "agent_cannot_touch_foreign_session_canvas" },
    });

    const err = parseWireResponseLine(
      JSON.stringify({
        v: 1,
        id: "r3",
        ok: false,
        error: { code: "ERR_INVALID_PAYLOAD", message: "bad" },
      }),
    );
    const m = toAuthorizeHttpBody(err);
    assert.equal(m.ok, false);
    assert.equal(m.httpStatus, 502);
    assert.ok(String(m.body.error).includes("ERR_INVALID_PAYLOAD"));
  });
});
