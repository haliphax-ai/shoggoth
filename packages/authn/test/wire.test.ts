import assert from "node:assert";
import { describe, it } from "vitest";
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
      auth: { kind: "operator_token", token: "tok" },
    });
    const req = parseRequestLine(line);
    assert.strictEqual(req.op, "ping");
    assert.strictEqual(req.auth.kind, "operator_token");
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
            auth: { kind: "operator_token", token: "t" },
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

  it("rejects unknown auth kind", () => {
    assert.throws(
      () =>
        parseRequestLine(
          JSON.stringify({
            v: WIRE_VERSION,
            id: "x",
            op: "ping",
            auth: { kind: "operator_peercred" },
          }),
        ),
      WireParseError,
    );
  });
  it("rejects response with wrong version", () => {
    assert.throws(
      () =>
        parseResponseLine(
          JSON.stringify({
            v: 99,
            id: "x",
            ok: true,
          }),
        ),
      WireParseError,
    );
  });

  it("rejects response missing ok boolean", () => {
    assert.throws(
      () =>
        parseResponseLine(
          JSON.stringify({
            v: WIRE_VERSION,
            id: "x",
          }),
        ),
      WireParseError,
    );
  });

  it("rejects ok:true response with error body", () => {
    assert.throws(
      () =>
        parseResponseLine(
          JSON.stringify({
            v: WIRE_VERSION,
            id: "x",
            ok: true,
            error: { code: "ERR_X", message: "boom" },
          }),
        ),
      WireParseError,
    );
  });

  it("rejects ok:false response without error body", () => {
    assert.throws(
      () =>
        parseResponseLine(
          JSON.stringify({
            v: WIRE_VERSION,
            id: "x",
            ok: false,
          }),
        ),
      WireParseError,
    );
  });

  it("rejects empty response line", () => {
    assert.throws(() => parseResponseLine(""), WireParseError);
    assert.throws(() => parseResponseLine("\r"), WireParseError);
  });

  it("omits lineNumber when the caller does not supply one", () => {
    const line = JSON.stringify({ v: 99, id: "x", op: "ping" });
    try {
      parseRequestLine(line);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof WireParseError);
      assert.strictEqual(e.lineNumber, undefined);
      assert.strictEqual(e.lineText, undefined);
    }
  });

  it("attaches the supplied lineNumber to request parse errors", () => {
    const line = JSON.stringify({ v: 99, id: "x", op: "ping" });
    try {
      parseRequestLine(line, 7);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof WireParseError);
      assert.strictEqual(e.lineNumber, 7);
    }
  });

  it("attaches lineNumber and lineText to invalid-json request errors", () => {
    try {
      parseRequestLine("{not json}", 3);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof WireParseError);
      assert.strictEqual(e.lineNumber, 3);
      assert.strictEqual(e.lineText, "{not json}");
    }
  });

  it("attaches the supplied lineNumber to response parse errors", () => {
    const line = JSON.stringify({ v: WIRE_VERSION, id: "x" });
    try {
      parseResponseLine(line, 12);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof WireParseError);
      assert.strictEqual(e.lineNumber, 12);
    }
  });

  it("attaches lineNumber to empty-line errors", () => {
    try {
      parseRequestLine("", 42);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof WireParseError);
      assert.strictEqual(e.lineNumber, 42);
    }
  });
});
