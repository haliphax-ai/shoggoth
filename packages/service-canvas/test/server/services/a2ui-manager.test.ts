/**
 * Data model merge tests for the A2UI manager.
 */

import { describe, it, expect } from "vitest";
import { A2UIManager, mergeDataModel } from "../../../src/server/services/a2ui-manager";
import { A2UIStore } from "../../../src/server/services/a2ui-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("mergeDataModel", () => {
  it("shallow keys merge deeply into the existing model", () => {
    const base = {
      filters: { region: "west", limit: 10 },
      meta: { title: "Dashboard" },
    };
    const update = { filters: { limit: 25 } };
    const merged = mergeDataModel(base, update);
    expect(merged).toEqual({
      filters: { region: "west", limit: 25 },
      meta: { title: "Dashboard" },
    });
    expect(merged.filters).not.toBe(base.filters);
    expect(merged.meta).toBe(base.meta);
  });

  it("arrays replace the previous value wholesale", () => {
    const base = { tags: ["a", "b", "c"], config: { sort: ["x"] } };
    const update = { tags: ["z"], config: { sort: ["y", "z"] } };
    const merged = mergeDataModel(base, update);
    expect(merged.tags).toEqual(["z"]);
    expect((merged.config as { sort: string[] }).sort).toEqual(["y", "z"]);
  });

  it("primitives overwrite the previous value", () => {
    const base = { count: 3, label: "old", flag: true };
    const update = { count: 7, label: "new", flag: false };
    expect(mergeDataModel(base, update)).toEqual({ count: 7, label: "new", flag: false });
  });

  it("sources are merged by name with each named source replaced wholesale", () => {
    const base = {
      $sources: {
        users: { fields: ["id", "name"], rows: [{ id: 1, name: "a" }] },
        roles: { fields: ["id"], rows: [{ id: 2 }] },
      },
    };
    const update = {
      $sources: {
        users: { fields: ["id", "name"], rows: [{ id: 3, name: "b" }] },
      },
    };
    const merged = mergeDataModel(base, update);
    // Untouched source survives; updated source is exactly the pushed one.
    expect(merged.$sources).toEqual({
      users: { fields: ["id", "name"], rows: [{ id: 3, name: "b" }] },
      roles: { fields: ["id"], rows: [{ id: 2 }] },
    });
  });

  it("a source push with fewer rows does not leave stale rows behind", () => {
    const base = {
      $sources: { users: { fields: ["id"], rows: [{ id: 1 }, { id: 2 }] } },
    };
    const update = {
      $sources: { users: { fields: ["id"], rows: [{ id: 1 }] } },
    };
    const merged = mergeDataModel(base, update);
    expect((merged.$sources as Record<string, { rows: unknown[] }>).users.rows).toEqual([
      { id: 1 },
    ]);
  });

  it("drops unsafe keys from updates at any depth", () => {
    const base = { safe: "keep" };
    // Raw JSON so __proto__ arrives as a real own-property key, exactly as an
    // untrusted wire payload would.
    const update = JSON.parse(
      '{"safe":"changed","__proto__":{"hacked":true},"nested":{"toString":"shadowed"}}',
    );
    expect(Object.getOwnPropertyNames(update)).toContain("__proto__");
    const merged = mergeDataModel(base, update as Record<string, unknown>);
    expect(merged.safe).toBe("changed");
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(merged).sort()).toEqual(["nested", "safe"]);
    expect(merged.nested).toEqual({}); // toString dropped, proto payload dropped
  });

  it("drops unsafe source names from $sources", () => {
    const base = { $sources: { users: { fields: ["id"], rows: [] } } };
    const update = {
      $sources: { users: { fields: ["id"], rows: [{ id: 9 }] }, constructor: { rows: [] } },
    };
    const merged = mergeDataModel(base, update);
    expect(Object.keys(merged.$sources as object)).toEqual(["users"]);
  });

  it("does not mutate the incoming update object", () => {
    const base = { config: { a: 1 } };
    const update = { config: { b: 2 } };
    mergeDataModel(base, update);
    expect(update).toEqual({ config: { b: 2 } });
  });

  it("skips undefined values in the update", () => {
    const base = { keep: "me", drop: "not" };
    const update = { drop: undefined };
    expect(mergeDataModel(base, update)).toEqual({ keep: "me", drop: "not" });
  });
});

describe("A2UIManager.updateDataModel", () => {
  it("merges nested model updates across successive calls", () => {
    const manager = new A2UIManager();
    manager.upsertSurface("s1", "surf1", []);
    manager.updateDataModel("s1", "surf1", { filters: { region: "west" }, count: 1 });
    manager.updateDataModel("s1", "surf1", { filters: { limit: 5 } });
    expect(manager.getSurface("s1", "surf1")?.dataModel).toEqual({
      filters: { region: "west", limit: 5 },
      count: 1,
    });
  });

  it("replaces a pushed source wholesale while merging sibling model keys", () => {
    const manager = new A2UIManager();
    manager.upsertSurface("s1", "surf1", []);
    manager.updateDataModel("s1", "surf1", {
      $sources: { users: { fields: ["id"], rows: [{ id: 1 }, { id: 2 }] } },
      filters: { region: "west" },
    });
    manager.updateDataModel("s1", "surf1", {
      $sources: { users: { fields: ["id"], rows: [{ id: 3 }] } },
      filters: { limit: 5 },
    });
    const dm = manager.getSurface("s1", "surf1")?.dataModel;
    expect(dm).toEqual({
      $sources: { users: { fields: ["id"], rows: [{ id: 3 }] } },
      filters: { region: "west", limit: 5 },
    });
  });

  it("does not leak changes to other surfaces in the same session", () => {
    const manager = new A2UIManager();
    manager.upsertSurface("s1", "surfA", []);
    manager.upsertSurface("s1", "surfB", []);
    manager.updateDataModel("s1", "surfA", { config: { a: 1 } });
    expect(manager.getSurface("s1", "surfB")?.dataModel).toEqual({});
  });

  it("normalizes array rows before merging", () => {
    const manager = new A2UIManager();
    manager.upsertSurface("s1", "surf1", []);
    manager.updateDataModel("s1", "surf1", {
      $sources: { users: { fields: ["id", "name"], rows: [[1, "a"]] } },
    });
    const dm = manager.getSurface("s1", "surf1")?.dataModel;
    expect(dm).toEqual({
      $sources: { users: { fields: ["id", "name"], rows: [{ id: 1, name: "a" }] } },
    });
  });
});

describe("A2UIManager.close", () => {
  it("closes the backing store through the manager", () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "a2ui-manager-close-"));
    const store = new A2UIStore(path.join(dbDir, "a2ui-manager-close.db"));
    const manager = new A2UIManager(store);

    manager.close();

    expect((store as unknown as { db: { open: boolean } }).db.open).toBe(false);
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("drops the store reference so persisted writes stop after close", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "a2ui-manager-close-"));
    const dbPath = path.join(dbDir, "a2ui-manager-close.db");
    const manager = new A2UIManager(new A2UIStore(dbPath));
    manager.upsertSurface("main", "surf1", [{ id: "c1", component: "Text", text: "hello" }]);

    manager.close();
    // Writes after close must be in-memory only, not crash on a closed DB.
    manager.upsertSurface("main", "surf1", [{ id: "c2", component: "Text", text: "after close" }]);
    expect(manager.getSurface("main", "surf1")?.components.get("c2")).toEqual({
      component: "Text",
      text: "after close",
    });

    const { default: Database } = await import("better-sqlite3");
    const reopened = new Database(dbPath, { readonly: true });
    const row = reopened
      .prepare("SELECT components FROM a2ui_surfaces WHERE session = ? AND surfaceId = ?")
      .get("main", "surf1") as { components: string } | undefined;
    reopened.close();

    expect(row).toBeDefined();
    const components = JSON.parse(row!.components) as Record<string, unknown>;
    expect(Object.keys(components)).toEqual(["c1"]);

    rmSync(dbDir, { recursive: true, force: true });
  });

  it("is safe to call when the manager has no store", () => {
    const manager = new A2UIManager();

    expect(() => manager.close()).not.toThrow();
  });

  it("is safe to call twice", () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "a2ui-manager-close-"));
    const store = new A2UIStore(path.join(dbDir, "a2ui-manager-close.db"));
    const manager = new A2UIManager(store);

    manager.close();

    expect(() => manager.close()).not.toThrow();
    expect((store as unknown as { db: { open: boolean } }).db.open).toBe(false);

    rmSync(dbDir, { recursive: true, force: true });
  });
});
