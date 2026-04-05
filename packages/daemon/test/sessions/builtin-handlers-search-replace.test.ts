import { describe, it } from "vitest";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSearchReplace } from "../../src/sessions/builtin-handlers/search-replace-handler";

function makeTmpWorkspace(): string {
  const dir = join(tmpdir(), `shog-sr-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stubCtx(workspacePath: string): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    db: {} as any,
    config: {} as any,
    env: {},
    workspacePath,
    creds: { uid: process.getuid!(), gid: process.getgid!() },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

async function exec(
  ws: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reg = new BuiltinToolRegistry();
  registerSearchReplace(reg);
  const result = await reg.execute("search-replace", args, stubCtx(ws));
  return JSON.parse(result.resultJson);
}

// ---------------------------------------------------------------------------
// Search tests
// ---------------------------------------------------------------------------

describe("search-replace: search", () => {
  it("basic pattern search returns matches", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "hello.txt"), "hello world\nhello there\ngoodbye");
      const result = await exec(ws, { action: "search", pattern: "hello" });
      assert.ok(!result.error, `unexpected error: ${result.error}`);
      const output = result.output as string;
      assert.ok(output.includes("hello world"));
      assert.ok(output.includes("hello there"));
      assert.ok(!output.includes("goodbye"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fixedStrings mode works", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "regex.txt"), "foo.bar\nfooXbar\n");
      const result = await exec(ws, {
        action: "search",
        pattern: "foo.bar",
        fixedStrings: true,
      });
      const output = result.output as string;
      // literal "foo.bar" matches only the first line
      assert.ok(output.includes("foo.bar"));
      assert.ok(!output.includes("fooXbar"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fileType filter works", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "a.ts"), "needle");
      writeFileSync(join(ws, "b.json"), "needle");
      const result = await exec(ws, {
        action: "search",
        pattern: "needle",
        fileType: "ts",
      });
      const output = result.output as string;
      assert.ok(output.includes("a.ts"));
      assert.ok(!output.includes("b.json"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("glob filter works", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "keep.ts"), "needle");
      writeFileSync(join(ws, "skip.test.ts"), "needle");
      const result = await exec(ws, {
        action: "search",
        pattern: "needle",
        glob: "!*.test.ts",
      });
      const output = result.output as string;
      assert.ok(output.includes("keep.ts"));
      assert.ok(!output.includes("skip.test.ts"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("case-insensitive search works", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "case.txt"), "Hello HELLO hello");
      const result = await exec(ws, {
        action: "search",
        pattern: "hello",
        caseSensitive: false,
      });
      const output = result.output as string;
      assert.ok(output.includes("Hello HELLO hello"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects paths outside workspace", async () => {
    const ws = makeTmpWorkspace();
    try {
      const result = await exec(ws, {
        action: "search",
        pattern: "x",
        path: "../../etc/passwd",
      });
      assert.ok(result.error);
      assert.ok((result.error as string).includes("escapes workspace"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maxResults truncation", async () => {
    const ws = makeTmpWorkspace();
    try {
      const lines = Array.from({ length: 500 }, (_, i) => `match${i}`).join("\n");
      writeFileSync(join(ws, "big.txt"), lines);
      const result = await exec(ws, {
        action: "search",
        pattern: "match",
        maxResults: 10,
      });
      const output = result.output as string;
      const outputLines = output.trimEnd().split("\n");
      assert.ok(outputLines.length <= 11); // 10 results + possible truncation notice
      assert.ok(result.truncated === true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Replace tests
// ---------------------------------------------------------------------------

describe("search-replace: replace", () => {
  it("basic literal replacement works", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "file.txt"), "foo bar foo baz");
      const result = await exec(ws, {
        action: "replace",
        file: "file.txt",
        match: "foo",
        replacement: "qux",
      });
      assert.ok(!result.error);
      assert.strictEqual(result.replacements, 1);
      const content = readFileSync(join(ws, "file.txt"), "utf8");
      assert.strictEqual(content, "qux bar foo baz");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("count parameter limits replacements", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "file.txt"), "aaa aaa aaa");
      const result = await exec(ws, {
        action: "replace",
        file: "file.txt",
        match: "aaa",
        replacement: "bbb",
        count: 2,
      });
      assert.strictEqual(result.replacements, 2);
      const content = readFileSync(join(ws, "file.txt"), "utf8");
      assert.strictEqual(content, "bbb bbb aaa");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("count=0 replaces all occurrences", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "file.txt"), "x x x");
      const result = await exec(ws, {
        action: "replace",
        file: "file.txt",
        match: "x",
        replacement: "y",
        count: 0,
      });
      assert.strictEqual(result.replacements, 3);
      const content = readFileSync(join(ws, "file.txt"), "utf8");
      assert.strictEqual(content, "y y y");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects paths outside workspace", async () => {
    const ws = makeTmpWorkspace();
    try {
      const result = await exec(ws, {
        action: "replace",
        file: "../../etc/passwd",
        match: "root",
        replacement: "hacked",
      });
      assert.ok(result.error);
      assert.ok((result.error as string).includes("escapes workspace"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns error when match not found", async () => {
    const ws = makeTmpWorkspace();
    try {
      writeFileSync(join(ws, "file.txt"), "hello world");
      const result = await exec(ws, {
        action: "replace",
        file: "file.txt",
        match: "nonexistent",
        replacement: "x",
      });
      assert.ok(result.error);
      assert.ok((result.error as string).includes("not found"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns error for non-existent file", async () => {
    const ws = makeTmpWorkspace();
    try {
      const result = await exec(ws, {
        action: "replace",
        file: "nope.txt",
        match: "x",
        replacement: "y",
      });
      assert.ok(result.error);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
