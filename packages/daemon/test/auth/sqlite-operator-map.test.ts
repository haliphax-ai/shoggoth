import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { chainOperatorMaps, operatorMapFromFileJson } from "@shoggoth/authn";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteOperatorMap } from "../../src/auth/sqlite-operator-map";

describe("createSqliteOperatorMap", () => {
  it("resolves uid from operator_uid_map before layered fallback", () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO operator_uid_map (uid, operator_id, roles_json) VALUES (2000, 'db-op', '["r1"]')`,
    ).run();
    const sqliteMap = createSqliteOperatorMap(db);
    const layered = operatorMapFromFileJson({
      byUid: { "2000": { operatorId: "json-op", roles: ["x"] } },
    });
    const combined = chainOperatorMaps([sqliteMap, layered]);
    assert.deepStrictEqual(combined.resolve(2000), {
      operatorId: "db-op",
      roles: ["r1"],
    });
  });
});
