import { describe, it, assert } from "vitest";
import { isRawPcmMime, parsePcmMimeParams, wrapPcmAsWav } from "../../src/media/pcm-to-wav";

describe("isRawPcmMime", () => {
  it("returns true for audio/L16", () => {
    assert.isTrue(isRawPcmMime("audio/L16"));
  });

  it("returns true for audio/L16 with params", () => {
    assert.isTrue(isRawPcmMime("audio/L16;codec=pcm;rate=24000"));
  });

  it("returns true for audio/L8", () => {
    assert.isTrue(isRawPcmMime("audio/L8"));
  });

  it("is case-insensitive", () => {
    assert.isTrue(isRawPcmMime("Audio/l16;rate=24000"));
  });

  it("returns false for audio/wav", () => {
    assert.isFalse(isRawPcmMime("audio/wav"));
  });

  it("returns false for audio/mpeg", () => {
    assert.isFalse(isRawPcmMime("audio/mpeg"));
  });

  it("returns false for image/png", () => {
    assert.isFalse(isRawPcmMime("image/png"));
  });
});

describe("parsePcmMimeParams", () => {
  it("parses rate from audio/L16;codec=pcm;rate=24000", () => {
    const p = parsePcmMimeParams("audio/L16;codec=pcm;rate=24000");
    assert.equal(p.sampleRate, 24000);
    assert.equal(p.channels, 1);
    assert.equal(p.bitsPerSample, 16);
  });

  it("parses rate=48000 and channels=2", () => {
    const p = parsePcmMimeParams("audio/L16;rate=48000;channels=2");
    assert.equal(p.sampleRate, 48000);
    assert.equal(p.channels, 2);
    assert.equal(p.bitsPerSample, 16);
  });

  it("defaults to 24000 Hz, 1 channel, 16-bit when no params", () => {
    const p = parsePcmMimeParams("audio/L16");
    assert.equal(p.sampleRate, 24000);
    assert.equal(p.channels, 1);
    assert.equal(p.bitsPerSample, 16);
  });

  it("forces 16-bit for audio/L16 even if bits param differs", () => {
    const p = parsePcmMimeParams("audio/L16;bits=8");
    assert.equal(p.bitsPerSample, 16);
  });

  it("ignores invalid rate values", () => {
    const p = parsePcmMimeParams("audio/L16;rate=abc");
    assert.equal(p.sampleRate, 24000);
  });

  it("handles spaces around params", () => {
    const p = parsePcmMimeParams("audio/L16 ; rate = 44100 ; channels = 2");
    assert.equal(p.sampleRate, 44100);
    assert.equal(p.channels, 2);
  });
});

describe("wrapPcmAsWav", () => {
  it("produces a valid 44-byte WAV header followed by PCM data", () => {
    const pcm = Buffer.alloc(100, 0xab);
    const wav = wrapPcmAsWav(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });

    assert.equal(wav.byteLength, 44 + 100);

    // RIFF header
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), 36 + 100); // ChunkSize
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");

    // fmt sub-chunk
    assert.equal(wav.toString("ascii", 12, 16), "fmt ");
    assert.equal(wav.readUInt32LE(16), 16); // Subchunk1Size
    assert.equal(wav.readUInt16LE(20), 1); // AudioFormat (PCM)
    assert.equal(wav.readUInt16LE(22), 1); // NumChannels
    assert.equal(wav.readUInt32LE(24), 24000); // SampleRate
    assert.equal(wav.readUInt32LE(28), 24000 * 1 * 2); // ByteRate
    assert.equal(wav.readUInt16LE(32), 1 * 2); // BlockAlign
    assert.equal(wav.readUInt16LE(34), 16); // BitsPerSample

    // data sub-chunk
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), 100); // data size

    // PCM payload preserved
    assert.deepEqual(wav.subarray(44), pcm);
  });

  it("handles stereo 48kHz correctly", () => {
    const pcm = Buffer.alloc(200);
    const wav = wrapPcmAsWav(pcm, { sampleRate: 48000, channels: 2, bitsPerSample: 16 });

    assert.equal(wav.readUInt16LE(22), 2); // NumChannels
    assert.equal(wav.readUInt32LE(24), 48000); // SampleRate
    assert.equal(wav.readUInt32LE(28), 48000 * 2 * 2); // ByteRate
    assert.equal(wav.readUInt16LE(32), 2 * 2); // BlockAlign
  });

  it("handles empty PCM data", () => {
    const pcm = Buffer.alloc(0);
    const wav = wrapPcmAsWav(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });

    assert.equal(wav.byteLength, 44);
    assert.equal(wav.readUInt32LE(4), 36); // ChunkSize
    assert.equal(wav.readUInt32LE(40), 0); // data size
  });
});
