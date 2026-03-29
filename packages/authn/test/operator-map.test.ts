import assert from "node:assert";
import { describe, it } from "node:test";
import {
  chainOperatorMaps,
  operatorMapFromFileJson,
  operatorPrincipalFromPeer,
} from "../src/operator-map";

describe("operator map", () => {
  it("resolves by uid", () => {
    const map = operatorMapFromFileJson({
      byUid: {
        "1000": { operatorId: "alice", roles: ["admin"] },
      },
    });
    assert.strictEqual(map.resolve(1000)?.operatorId, "alice");
    assert.strictEqual(map.resolve(1001), null);
  });

  it("uses defaultOperator when uid missing", () => {
    const map = operatorMapFromFileJson({
      defaultOperator: { operatorId: "solo", roles: ["admin"] },
      byUid: {},
    });
    assert.strictEqual(map.resolve(999)?.operatorId, "solo");
  });

  it("chains maps with first match winning", () => {
    const a = operatorMapFromFileJson({
      byUid: { "1000": { operatorId: "from-a", roles: [] } },
    });
    const b = operatorMapFromFileJson({
      byUid: { "1000": { operatorId: "from-b", roles: ["x"] } },
      defaultOperator: { operatorId: "solo", roles: ["admin"] },
    });
    const c = chainOperatorMaps([a, b]);
    assert.strictEqual(c.resolve(1000)?.operatorId, "from-a");
    assert.strictEqual(c.resolve(999)?.operatorId, "solo");
  });

  it("builds operator principal with peer metadata", () => {
    const map = operatorMapFromFileJson({
      byUid: { "0": { operatorId: "root", roles: ["admin"] } },
    });
    const p = operatorPrincipalFromPeer({ uid: 0, gid: 0, pid: 42 }, map);
    assert(p);
    assert.strictEqual(p!.operatorId, "root");
    assert.deepStrictEqual(p!.peer, { uid: 0, gid: 0, pid: 42 });
  });
});
