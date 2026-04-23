import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";

// Mock invokeControlRequest before importing the module under test
const mockInvoke = vi.fn();
vi.mock("@shoggoth/daemon/lib", () => ({
  invokeControlRequest: (...args: unknown[]) => mockInvoke(...args),
}));

const mockLoadLayeredConfig = vi.fn().mockReturnValue({ socketPath: "/tmp/test.sock" });
vi.mock("@shoggoth/shared", () => ({
  loadLayeredConfig: (...args: unknown[]) => mockLoadLayeredConfig(...args),
  LAYOUT: { configDir: "/tmp/cfg" },
  VERSION: "0.0.0-test",
}));

import {
  parseMediaGenerateArgs,
  parseMediaPollArgs,
  runMediaCli,
  BUILTIN_MEDIA_MODELS,
} from "../src/run-media";

let logged: string[] = [];
let errored: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  errored = [];
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errored.push(args.map(String).join(" "));
  process.exitCode = undefined;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-token";
  process.env.SHOGGOTH_CONTROL_SOCKET = "/tmp/test.sock";
  mockInvoke.mockReset();
  mockLoadLayeredConfig.mockReset().mockReturnValue({ socketPath: "/tmp/test.sock" });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  delete process.env.SHOGGOTH_CONTROL_SOCKET;
});

// ---------------------------------------------------------------------------
// parseMediaGenerateArgs
// ---------------------------------------------------------------------------
describe("parseMediaGenerateArgs", () => {
  it("parses --model, --prompt, --provider, --output flags", () => {
    const result = parseMediaGenerateArgs([
      "--model",
      "gemini-2.5-flash-image",
      "--prompt",
      "a cat",
      "--provider",
      "gemini-1",
      "--output",
      "/tmp/out.png",
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.model, "gemini-2.5-flash-image");
    assert.strictEqual(result.payload.prompt, "a cat");
    assert.strictEqual(result.payload.provider_id, "gemini-1");
    assert.strictEqual(result.payload.output_path, "/tmp/out.png");
  });

  it("parses --param key=value pairs into params object", () => {
    const result = parseMediaGenerateArgs([
      "--model",
      "gemini-2.5-flash-image",
      "--prompt",
      "a dog",
      "--provider",
      "g1",
      "--param",
      "kind=image",
      "--param",
      "aspectRatio=16:9",
      "--param",
      "numberOfImages=3",
    ]);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.payload.params, {
      kind: "image",
      aspectRatio: "16:9",
      numberOfImages: "3",
    });
  });

  it("requires --model", () => {
    const result = parseMediaGenerateArgs(["--prompt", "hello", "--provider", "g"]);
    assert.strictEqual(result.ok, false);
  });

  it("requires --prompt", () => {
    const result = parseMediaGenerateArgs(["--model", "m", "--provider", "g"]);
    assert.strictEqual(result.ok, false);
  });

  it("requires --provider", () => {
    const result = parseMediaGenerateArgs(["--model", "m", "--prompt", "p"]);
    assert.strictEqual(result.ok, false);
  });

  it("handles --param with missing value gracefully", () => {
    const result = parseMediaGenerateArgs([
      "--model",
      "m",
      "--prompt",
      "p",
      "--provider",
      "g",
      "--param",
      "noequals",
    ]);
    // A param without '=' should either be rejected or treated as key with empty value
    // The implementation should handle this; either way it should not crash
    assert.ok(typeof result.ok === "boolean");
  });
});

// ---------------------------------------------------------------------------
// parseMediaPollArgs
// ---------------------------------------------------------------------------
describe("parseMediaPollArgs", () => {
  it("parses --provider, --operation, --output flags", () => {
    const result = parseMediaPollArgs([
      "--provider",
      "gemini-1",
      "--operation",
      "operations/abc123",
      "--output",
      "/tmp/video.mp4",
    ]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.provider_id, "gemini-1");
    assert.strictEqual(result.payload.operation_id, "operations/abc123");
    assert.strictEqual(result.payload.output_path, "/tmp/video.mp4");
  });

  it("requires --provider", () => {
    const result = parseMediaPollArgs(["--operation", "op/1"]);
    assert.strictEqual(result.ok, false);
  });

  it("requires --operation", () => {
    const result = parseMediaPollArgs(["--provider", "g1"]);
    assert.strictEqual(result.ok, false);
  });

  it("output is optional", () => {
    const result = parseMediaPollArgs(["--provider", "g1", "--operation", "op/1"]);
    assert.ok(result.ok);
    assert.strictEqual(result.payload.output_path, undefined);
  });
});

// ---------------------------------------------------------------------------
// shoggoth media generate — control op integration
// ---------------------------------------------------------------------------
describe("runMediaCli generate", () => {
  it("sends media_generate control op with correct payload", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "complete", path: "/tmp/out.png", mime_type: "image/png" },
    });

    await runMediaCli([
      "generate",
      "--model",
      "gemini-2.5-flash-image",
      "--prompt",
      "a cat on a roof",
      "--provider",
      "gemini-1",
      "--output",
      "/tmp/out.png",
      "--param",
      "kind=image",
    ]);

    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0][0];
    assert.strictEqual(call.op, "media_generate");
    assert.strictEqual(call.payload.model, "gemini-2.5-flash-image");
    assert.strictEqual(call.payload.prompt, "a cat on a roof");
    assert.strictEqual(call.payload.provider_id, "gemini-1");
    assert.strictEqual(call.payload.output_path, "/tmp/out.png");
    assert.deepStrictEqual(call.payload.params, { kind: "image" });
  });

  it("displays result path on success", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "complete", path: "/workspace/img.png", mime_type: "image/png" },
    });

    await runMediaCli([
      "generate",
      "--model",
      "gemini-2.5-flash-image",
      "--prompt",
      "test",
      "--provider",
      "g1",
    ]);

    const output = logged.join("\n");
    assert.ok(output.includes("/workspace/img.png"), `Expected path in output: ${output}`);
  });

  it("displays error message on failure", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "error", error: "Rate limit exceeded" },
    });

    await runMediaCli([
      "generate",
      "--model",
      "gemini-2.5-flash-image",
      "--prompt",
      "test",
      "--provider",
      "g1",
    ]);

    const allOutput = [...logged, ...errored].join("\n");
    assert.ok(allOutput.includes("Rate limit exceeded"), `Expected error in output: ${allOutput}`);
  });

  it("displays error when control op itself fails", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      error: { message: "socket unreachable" },
    });

    await runMediaCli(["generate", "--model", "m", "--prompt", "p", "--provider", "g"]);

    assert.ok(process.exitCode === 1);
  });

  it("sets exit code on missing required args", async () => {
    await runMediaCli(["generate", "--model", "m"]);
    assert.ok(process.exitCode === 1);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// shoggoth media poll — control op integration
// ---------------------------------------------------------------------------
describe("runMediaCli poll", () => {
  it("sends media_generate_poll control op", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "complete", path: "/tmp/video.mp4", mime_type: "video/mp4" },
    });

    await runMediaCli([
      "poll",
      "--provider",
      "gemini-1",
      "--operation",
      "operations/xyz",
      "--output",
      "/tmp/video.mp4",
    ]);

    assert.strictEqual(mockInvoke.mock.calls.length, 1);
    const call = mockInvoke.mock.calls[0][0];
    assert.strictEqual(call.op, "media_generate_poll");
    assert.strictEqual(call.payload.provider_id, "gemini-1");
    assert.strictEqual(call.payload.operation_id, "operations/xyz");
    assert.strictEqual(call.payload.output_path, "/tmp/video.mp4");
  });

  it("displays result on completion", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "complete", path: "/out/clip.mp4", mime_type: "video/mp4" },
    });

    await runMediaCli(["poll", "--provider", "g1", "--operation", "op/1"]);

    const output = logged.join("\n");
    assert.ok(output.includes("/out/clip.mp4"), `Expected path in output: ${output}`);
  });

  it("displays in-progress status", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      result: { status: "in_progress", operation_id: "op/still-going" },
    });

    await runMediaCli(["poll", "--provider", "g1", "--operation", "op/still-going"]);

    const output = logged.join("\n");
    assert.ok(
      output.includes("in_progress") || output.includes("in progress"),
      `Expected in-progress status in output: ${output}`,
    );
  });

  it("sets exit code on missing required args", async () => {
    await runMediaCli(["poll", "--provider", "g1"]);
    assert.ok(process.exitCode === 1);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// shoggoth media models
// ---------------------------------------------------------------------------
describe("runMediaCli models", () => {
  it("lists available media generation models from the built-in map", async () => {
    await runMediaCli(["models"]);

    const output = logged.join("\n");
    // Should list known built-in models
    assert.ok(
      output.includes("gemini-2.5-flash-image"),
      `Expected gemini-2.5-flash-image in output: `,
    );
    assert.ok(output.includes("imagen"), `Expected imagen in output: ${output}`);
    assert.ok(output.includes("veo"), `Expected veo in output: ${output}`);
    assert.ok(output.includes("lyria-3"), `Expected lyria-3 in output: ${output}`);
  });

  it("exports BUILTIN_MEDIA_MODELS containing known models", () => {
    assert.ok(typeof BUILTIN_MEDIA_MODELS === "object");
    assert.ok("gemini-2.5-flash-image" in BUILTIN_MEDIA_MODELS);
    assert.ok("imagen" in BUILTIN_MEDIA_MODELS);
    assert.ok("veo" in BUILTIN_MEDIA_MODELS);
  });

  it("does not call control socket", async () => {
    await runMediaCli(["models"]);
    assert.strictEqual(mockInvoke.mock.calls.length, 0);
  });

  it("includes operator-configured models from mediaGeneration.modelAdapterMap", async () => {
    mockLoadLayeredConfig.mockReturnValue({
      socketPath: "/tmp/test.sock",
      mediaGeneration: {
        modelAdapterMap: {
          "my-custom-model": "generateContent",
        },
      },
    });

    await runMediaCli(["models"]);

    const output = logged.join("\n");
    assert.ok(output.includes("my-custom-model"), `Expected my-custom-model in output: ${output}`);
    assert.ok(output.includes("(config)"), `Expected (config) tag for operator model: ${output}`);
    // Built-in models should still be present
    assert.ok(output.includes("gemini-2.5-flash-image"), `Expected built-in model: ${output}`);
  });
});

// ---------------------------------------------------------------------------
// shoggoth media --help / unknown subcommand
// ---------------------------------------------------------------------------
describe("runMediaCli help and unknown", () => {
  it("prints help with no args", async () => {
    await runMediaCli([]);
    const output = logged.join("\n");
    assert.ok(output.includes("generate") && output.includes("poll") && output.includes("models"));
  });

  it("prints help with --help", async () => {
    await runMediaCli(["--help"]);
    const output = logged.join("\n");
    assert.ok(output.includes("generate"));
  });

  it("sets exit code for unknown subcommand", async () => {
    await runMediaCli(["bogus"]);
    assert.ok(process.exitCode === 1);
  });
});
