import { describe, it, expect, vi } from "vitest";
import type { MessageAttachment } from "@shoggoth/messaging";
import { downloadInboundAttachments } from "../../src/presentation/attachment-download.js";

// DI: inject runAsUser via options instead of mocking @shoggoth/os-exec
// (import-order dependent under --no-isolate).
const mockRunAsUser = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

function makeAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "att-1",
    url: "https://cdn.example.com/photo.png",
    filename: "photo.png",
    contentType: "image/png",
    sizeBytes: 1024,
    ...overrides,
  };
}

function makeFetchOk(body: Buffer = Buffer.from("file-bytes")) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String(body.byteLength),
    }),
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  });
}

const baseOpts = {
  messageId: "msg-123",
  workspacePath: "/workspace/agent-foo",
  creds: { uid: 1000, gid: 1000 },
} as const;

describe("downloadInboundAttachments", () => {
  it("downloads attachments and returns enriched list with localPath", async () => {
    const fetchImpl = makeFetchOk();
    const attachment = makeAttachment();

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBe("media/inbound/msg-123_photo.png");
    expect(fetchImpl).toHaveBeenCalledWith(attachment.url);
  });

  it("handles multiple attachments in parallel (all get localPath)", async () => {
    const fetchImpl = makeFetchOk();
    const attachments = [
      makeAttachment({ id: "a1", filename: "one.png", url: "https://cdn.example.com/one.png" }),
      makeAttachment({ id: "a2", filename: "two.jpg", url: "https://cdn.example.com/two.jpg" }),
      makeAttachment({ id: "a3", filename: "three.csv", url: "https://cdn.example.com/three.csv" }),
    ];

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(3);
    expect(result[0].localPath).toBe("media/inbound/msg-123_one.png");
    expect(result[1].localPath).toBe("media/inbound/msg-123_two.jpg");
    expect(result[2].localPath).toBe("media/inbound/msg-123_three.csv");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("skips attachments exceeding maxBytes (Content-Length pre-check)", async () => {
    const arrayBufferSpy = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "999999" }),
      arrayBuffer: arrayBufferSpy,
    });
    const attachment = makeAttachment({ sizeBytes: 999999 });

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      maxBytes: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBeUndefined();
    // Should not have consumed the body
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("skips attachments when fetch fails (network error)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const attachment = makeAttachment();

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBeUndefined();
  });

  it("skips attachments when fetch returns non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    });
    const attachment = makeAttachment();

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBeUndefined();
  });

  it("sanitizes filenames: strips '..', '/', '\\', control characters", async () => {
    const fetchImpl = makeFetchOk();
    const attachment = makeAttachment({
      filename: "../../../etc/passwd\x00evil.txt",
    });

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBeDefined();
    const localPath = result[0].localPath!;
    expect(localPath).not.toContain("..");
    expect(localPath).not.toContain("\\");
    expect(localPath).not.toContain("\x00");
    // Should still be under media/inbound/
    expect(localPath).toMatch(/^media\/inbound\/msg-123_/);
  });

  it("returns empty array for empty attachments input", async () => {
    const fetchImpl = vi.fn();

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("handles buffer size exceeding maxBytes even when Content-Length header is absent", async () => {
    const bigBuf = Buffer.alloc(5000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(), // no content-length
      arrayBuffer: () =>
        Promise.resolve(
          bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength),
        ),
    });
    const attachment = makeAttachment();

    const result = await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      maxBytes: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(result).toHaveLength(1);
    expect(result[0].localPath).toBeUndefined();
  });

  it("calls runAsUser to write files with correct path and creds", async () => {
    mockRunAsUser.mockClear();

    const fetchImpl = makeFetchOk();
    const attachment = makeAttachment();

    await downloadInboundAttachments({
      ...baseOpts,
      attachments: [attachment],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsUserImpl: mockRunAsUser,
    });

    expect(mockRunAsUser).toHaveBeenCalled();
    const call = mockRunAsUser.mock.calls[0][0];
    expect(call.uid).toBe(1000);
    expect(call.gid).toBe(1000);
  });
});
