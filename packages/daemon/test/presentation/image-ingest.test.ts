import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageAttachment } from "@shoggoth/messaging";
import type { ImageBlock, ImageBlockCodec } from "@shoggoth/models";
import { ingestAttachmentImage, type ImageIngestOptions } from "../../src/presentation/image-ingest.js";

// Suppress logger output in tests
vi.mock("../../src/logging.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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
        arrayBuffer: () => Promise.resolve(imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength)),
      });
      const attachment = makeAttachment();

      const result = await ingestAttachmentImage(attachment, {
        codec,
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
        arrayBuffer: () => Promise.resolve(imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength)),
      });
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "screenshot.jpeg",
      });

      const result = await ingestAttachmentImage(attachment, {
        codec,
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
        arrayBuffer: () => Promise.resolve(imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength)),
      });
      const attachment = makeAttachment({
        contentType: undefined,
        filename: "pic.jpg",
      });

      const result = await ingestAttachmentImage(attachment, {
        codec,
        fetchImpl: fetchImpl as any,
      });

      expect(result).toEqual({
        type: "image",
        mediaType: "image/jpeg",
        base64: imgBytes.toString("base64"),
      });
    });
  });

  describe("base64 fallback (supportsUrl: false)", () => {
    it("fetches and returns base64 ImageBlock", async () => {
      const codec = makeCodec(false);
      const imageBytes = Buffer.from("fake-png-data");
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": String(imageBytes.byteLength) }),
        arrayBuffer: () => Promise.resolve(imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength)),
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
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
        arrayBuffer: () => Promise.resolve(bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength)),
      });

      const attachment = makeAttachment();
      const result = await ingestAttachmentImage(attachment, {
        codec,
        maxBytes: 1000,
        fetchImpl: fetchImpl as any,
      });

      expect(result).toBeNull();
    });
  });
});
