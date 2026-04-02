import { describe, it } from "vitest";
import assert from "node:assert";
import { formatAttachmentMetadata, formatBytes } from "../src/attachment-metadata";

describe("formatAttachmentMetadata", () => {
  it("formats a single attachment with all fields", () => {
    const result = formatAttachmentMetadata([
      { id: "1", url: "https://cdn.discord/a.png", filename: "photo.png", contentType: "image/png", sizeBytes: 1234 },
    ]);
    assert.strictEqual(
      result,
      "[message has 1 attachment(s)]\n- photo.png (image/png, 1.2 KB)",
    );
  });

  it("formats multiple attachments", () => {
    const result = formatAttachmentMetadata([
      { id: "1", url: "https://cdn.discord/a.png", filename: "photo.png", contentType: "image/png", sizeBytes: 2048 },
      { id: "2", url: "https://cdn.discord/b.pdf", filename: "doc.pdf", contentType: "application/pdf", sizeBytes: 3565158 },
    ]);
    assert.strictEqual(
      result,
      "[message has 2 attachment(s)]\n- photo.png (image/png, 2.0 KB)\n- doc.pdf (application/pdf, 3.4 MB)",
    );
  });

  it("omits contentType when missing", () => {
    const result = formatAttachmentMetadata([
      { id: "1", url: "https://cdn.discord/a.bin", filename: "data.bin", sizeBytes: 512 },
    ]);
    assert.strictEqual(
      result,
      "[message has 1 attachment(s)]\n- data.bin (512 bytes)",
    );
  });

  it("omits size when sizeBytes is missing", () => {
    const result = formatAttachmentMetadata([
      { id: "1", url: "https://cdn.discord/a.txt", filename: "notes.txt", contentType: "text/plain" },
    ]);
    assert.strictEqual(
      result,
      "[message has 1 attachment(s)]\n- notes.txt (text/plain)",
    );
  });

  it("omits parenthetical when both contentType and sizeBytes are missing", () => {
    const result = formatAttachmentMetadata([
      { id: "1", url: "https://cdn.discord/a.dat", filename: "mystery.dat" },
    ]);
    assert.strictEqual(
      result,
      "[message has 1 attachment(s)]\n- mystery.dat",
    );
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    assert.strictEqual(formatBytes(0), "0 bytes");
    assert.strictEqual(formatBytes(512), "512 bytes");
    assert.strictEqual(formatBytes(1023), "1023 bytes");
  });

  it("formats KB", () => {
    assert.strictEqual(formatBytes(1024), "1.0 KB");
    assert.strictEqual(formatBytes(1536), "1.5 KB");
  });

  it("formats MB", () => {
    assert.strictEqual(formatBytes(1048576), "1.0 MB");
    assert.strictEqual(formatBytes(3565158), "3.4 MB");
  });

  it("formats GB", () => {
    assert.strictEqual(formatBytes(1073741824), "1.0 GB");
    assert.strictEqual(formatBytes(2684354560), "2.5 GB");
  });
});
