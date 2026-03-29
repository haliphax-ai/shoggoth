import assert from "node:assert";
import { describe, it } from "node:test";
import {
  parseRequestLine,
  parseResponseLine,
  serializeResponse,
  WIRE_VERSION,
  WireParseError,
} from "../src/wire";

describe("JSONL wire", () => {
  it("roundtrips a ping request", () => {
    const line = JSON.stringify({
      v: WIRE_VERSION,
      id: "r1",
      op: "ping",
      auth: { kind: "operator_peercred" },
    });
    const req = parseRequestLine(line);
    assert.strictEqual(req.op, "ping");
    assert.strictEqual(req.auth.kind, "operator_peercred");
  });

  it("roundtrips response", () => {
    const res = {
      v: WIRE_VERSION,
      id: "r1",
      ok: true,
      result: { pong: true },
    };
    const back = parseResponseLine(serializeResponse(res).trimEnd());
    assert.deepStrictEqual(back, res);
  });

  it("rejects wrong version", () => {
    assert.throws(
      () =>
        parseRequestLine(
          JSON.stringify({
            v: 99,
            id: "x",
            op: "ping",
            auth: { kind: "operator_peercred" },
          }),
        ),
      WireParseError,
    );
  });

  it("rejects agent auth without session_id", () => {
    assert.throws(
      () =>
        parseRequestLine(
          JSON.stringify({
            v: WIRE_VERSION,
            id: "x",
            op: "x",
            auth: { kind: "agent", token: "t" },
          }),
        ),
      WireParseError,
    );
  });
});
