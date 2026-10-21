import { describe, it, expect, vi } from "vitest";
import type { MessageAttachment } from "@shoggoth/messaging";
import type { ImageBlockCodec } from "@shoggoth/models";
import { ingestAttachmentImage } from "../../src/presentation/image-ingest.js";

// DI: inject readFile via options instead of mocking node:fs/promises
// (import-order dependent under --no-isolate).
const mockReadFile = vi.fn();

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

function makeCodec(supportsUrl: boolean): ImageBlockCodec {
  return {
    supportsUrl,
    encode: vi.fn(),
    decode: vi.fn(),
  };
}

describe("ingestAttachmentImage", () => {
  describe("always fetches and base64-encodes (even when supportsUrl: true)", () => {
    it("fetches and returns base64 ImageBlock even with supportsUrl codec", async () => {
      const codec = makeCodec(true);
      const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () =>
          Promise.resolve(
            imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength),
          ),
      });
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        base64: imgBytes.toString("base64"),
      });
      expect(fetchImpl).toHaveBeenCalledWith(attachment.url);
    });

    it("infers MIME from filename when contentType is missing", async () => {
      const codec = makeCodec(true);
      const imgBytes = Buffer.from([0xff, 0xd8]);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () =>
          Promise.resolve(
            imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength),
          ),
      });
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "screenshot.jpeg",
      });

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/jpeg",
        base64: imgBytes.toString("base64"),
      });
    });

    it("infers MIME from .jpg extension", async () => {
      const codec = makeCodec(true);
      const imgBytes = Buffer.from([0xff, 0xd8]);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () =>
          Promise.resolve(
            imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength),
          ),
      });
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "pic.jpg",
      });

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/jpeg",
        base64: imgBytes.toString("base64"),
      });
    });
  });

  describe("imageUrlPassthrough option", () => {
    it("returns URL-only ImageBlock when imageUrlPassthrough is true and codec supports URLs", async () => {
      const codec = makeCodec(true);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        imageUrlPassthrough: true,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        url: "https://cdn.example.com/photo.png",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fetches when imageUrlPassthrough is true but codec does not support URLs", async () => {
      const codec = makeCodec(false);
      const imgBytes = Buffer.from([0x89, 0x50]);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () =>
          Promise.resolve(
            imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength),
          ),
      });
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        imageUrlPassthrough: true,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        base64: imgBytes.toString("base64"),
      });
      expect(fetchImpl).toHaveBeenCalled();
    });

    it("fetches when imageUrlPassthrough is false even if codec supports URLs", async () => {
      const codec = makeCodec(true);
      const imgBytes = Buffer.from([0x89, 0x50]);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () =>
          Promise.resolve(
            imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength),
          ),
      });
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        imageUrlPassthrough: false,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        base64: imgBytes.toString("base64"),
      });
      expect(fetchImpl).toHaveBeenCalled();
    });
  });

  describe("base64 fallback (supportsUrl: false)", () => {
    it("fetches and returns base64 ImageBlock", async () => {
      const codec = makeCodec(false);
      const imageBytes = Buffer.from("fake-png-data");
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          "content-length": String(imageBytes.byteLength),
        }),
        arrayBuffer: () =>
          Promise.resolve(
            imageBytes.buffer.slice(
              imageBytes.byteOffset,
              imageBytes.byteOffset + imageBytes.byteLength,
            ),
          ),
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        base64: imageBytes.toString("base64"),
      });
      expect(result!.url).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example.com/photo.png");
    });
  });

  describe("non-image attachment", () => {
    it("returns null for non-image contentType", async () => {
      const codec = makeCodec(true);
      const attachment = makeAttachment({
        contentType: "application/pdf",
        filename: "doc.pdf",
      });

      const result = await ingestAttachmentImage(attachment, { codec });
      expect(result).toBeNull();
    });

    it("returns null when contentType is missing and extension is not an image", async () => {
      const codec = makeCodec(true);
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "data.csv",
      });

      const result = await ingestAttachmentImage(attachment, { codec });
      expect(result).toBeNull();
    });

    it("returns null when contentType is missing and filename has no extension", async () => {
      const codec = makeCodec(true);
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "noext",
      });

      const result = await ingestAttachmentImage(attachment, { codec });
      expect(result).toBeNull();
    });
  });

  describe("fetch failure", () => {
    it("returns null without throwing on network error", async () => {
      const codec = makeCodec(false);
      const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toBeNull();
    });

    it("returns null on non-ok HTTP response", async () => {
      const codec = makeCodec(false);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toBeNull();
    });
  });

  describe("oversized image", () => {
    it("returns null when Content-Length exceeds maxBytes", async () => {
      const codec = makeCodec(false);
      const arrayBufferSpy = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": "999999" }),
        arrayBuffer: arrayBufferSpy,
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        maxBytes: 1000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toBeNull();
      // Should not have read the body
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    });

    it("returns null when buffer size exceeds maxBytes (no Content-Length header)", async () => {
      const codec = makeCodec(false);
      const bigBuf = Buffer.alloc(2000);
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(), // no content-length
        arrayBuffer: () =>
          Promise.resolve(
            bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength),
          ),
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        maxBytes: 1000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
      });

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // NEW: localFilePath option — reads from disk instead of fetching URL
  // -------------------------------------------------------------------------

  describe("localFilePath option", () => {
    it("reads from disk instead of fetching the URL when localFilePath is provided", async () => {
      // PNG magic bytes so detectMediaTypeFromBytes returns image/png
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ]);
      mockReadFile.mockResolvedValue(pngBytes);

      const codec = makeCodec(false);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        localFilePath: "/workspace/media/inbound/msg123_photo.png",
        readFileImpl: mockReadFile,
      });

      // Should NOT have fetched the URL
      expect(fetchImpl).not.toHaveBeenCalled();

      // Should have read from disk
      expect(mockReadFile).toHaveBeenCalledWith("/workspace/media/inbound/msg123_photo.png");

      // Should return a valid base64 ImageBlock
      expect(result).toEqual({
        type: "image",
        mediaType: "image/png",
        base64: pngBytes.toString("base64"),
      });
    });

    it("does NOT call fetch when localFilePath is set", async () => {
      const jpegBytes = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      mockReadFile.mockResolvedValue(jpegBytes);

      const codec = makeCodec(false);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment({ contentType: "image/jpeg", filename: "pic.jpg" });

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        localFilePath: "/workspace/media/inbound/msg456_pic.jpg",
        readFileImpl: mockReadFile,
      });

      // fetch must NOT be called
      expect(fetchImpl).not.toHaveBeenCalled();

      // Should return a valid ImageBlock
      expect(result).not.toBeNull();
      expect(result!.type).toBe("image");
      expect(result!.base64).toBe(jpegBytes.toString("base64"));
    });

    it("returns correct base64 from the local file", async () => {
      // WebP magic: RIFF....WEBP
      const webpBytes = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // RIFF
        0x00,
        0x00,
        0x00,
        0x00, // size placeholder
        0x57,
        0x45,
        0x42,
        0x50, // WEBP
        0x56,
        0x50,
        0x38,
        0x20, // VP8 chunk
      ]);
      mockReadFile.mockResolvedValue(webpBytes);

      const codec = makeCodec(false);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment({ contentType: "image/webp", filename: "anim.webp" });

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        localFilePath: "/workspace/media/inbound/msg789_anim.webp",
        readFileImpl: mockReadFile,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/webp",
        base64: webpBytes.toString("base64"),
      });
    });

    it("rejects oversized local files", async () => {
      const oversizedBuf = Buffer.alloc(5000);
      // Write PNG header so it's recognized as an image
      oversizedBuf[0] = 0x89;
      oversizedBuf[1] = 0x50;
      oversizedBuf[2] = 0x4e;
      oversizedBuf[3] = 0x47;
      mockReadFile.mockResolvedValue(oversizedBuf);

      const codec = makeCodec(false);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        maxBytes: 1000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        localFilePath: "/workspace/media/inbound/msg999_huge.png",
        readFileImpl: mockReadFile,
      });

      // Should be rejected due to size
      expect(result).toBeNull();
      // Should NOT have fetched
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns null when local file read fails", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const codec = makeCodec(false);
      const fetchImpl = vi.fn();
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: fetchImpl as any,
        localFilePath: "/workspace/media/inbound/missing.png",
        readFileImpl: mockReadFile,
      });

      // Should gracefully return null, not throw
      expect(result).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
