import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("reads back what was written", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello"));
    assert.equal(rb.readString(), "hello");
    assert.equal(rb.byteLength, 5);
  });

  it("accumulates multiple writes", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("foo"));
    rb.write(Buffer.from("bar"));
    assert.equal(rb.readString(), "foobar");
    assert.equal(rb.byteLength, 6);
  });

  it("overwrites oldest data on overflow", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("ABCDEFGH")); // fills exactly
    assert.equal(rb.readString(), "ABCDEFGH");

    rb.write(Buffer.from("IJ")); // overwrites A, B
    assert.equal(rb.readString(), "CDEFGHIJ");
    assert.equal(rb.byteLength, 8);
  });

  it("handles chunk larger than buffer", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("ABCDEFGH"));
    assert.equal(rb.readString(), "EFGH");
    assert.equal(rb.byteLength, 4);
  });

  it("handles wrap-around correctly", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("ABCDEF")); // 6 bytes, head at 6
    rb.write(Buffer.from("GHIJ"));   // wraps: GH at [6,7], IJ at [0,1]
    assert.equal(rb.readString(), "CDEFGHIJ");
  });

  it("clear resets the buffer", () => {
    const rb = new RingBuffer(16);
    rb.write(Buffer.from("hello"));
    rb.clear();
    assert.equal(rb.byteLength, 0);
    assert.equal(rb.readString(), "");
  });

  it("read returns empty buffer when nothing written", () => {
    const rb = new RingBuffer(16);
    assert.equal(rb.byteLength, 0);
    const buf = rb.read();
    assert.equal(buf.length, 0);
  });

  it("ignores empty writes", () => {
    const rb = new RingBuffer(16);
    rb.write(Buffer.from("hi"));
    rb.write(Buffer.alloc(0));
    assert.equal(rb.readString(), "hi");
    assert.equal(rb.byteLength, 2);
  });
});
