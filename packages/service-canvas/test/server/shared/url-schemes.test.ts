/**
 * URL Schemes Tests
 */

import { describe, it, expect } from "vitest";
import {
  SCHEME_AGENT,
  SCHEME_FILEPROMPT,
  SCHEME_CANVAS,
} from "../../../src/server/shared/url-schemes";

describe("URL Schemes", () => {
  describe("SCHEME_AGENT", () => {
    it("should use shoggoth:// not openclaw://", () => {
      expect(SCHEME_AGENT).toBe("shoggoth://");
      expect(SCHEME_AGENT).not.toBe("openclaw://");
    });
  });

  describe("SCHEME_FILEPROMPT", () => {
    it("should be shoggoth-fileprompt://", () => {
      expect(SCHEME_FILEPROMPT).toBe("shoggoth-fileprompt://");
    });

    it("should parse correctly", () => {
      const url = "shoggoth-fileprompt://prompt.txt";
      expect(url.startsWith(SCHEME_FILEPROMPT)).toBe(true);
    });
  });

  describe("SCHEME_CANVAS", () => {
    it("should be shoggoth-canvas://", () => {
      expect(SCHEME_CANVAS).toBe("shoggoth-canvas://");
    });

    it("should parse correctly", () => {
      const url = "shoggoth-canvas://canvas123";
      expect(url.startsWith(SCHEME_CANVAS)).toBe(true);
    });
  });
});
