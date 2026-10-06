import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";

export type FetchCaBundleValidation = { ok: true } | { ok: false; reason: string };

const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Validate PEM certificate bundle content: it must contain at least one
 * well-formed certificate block, every block must parse as an X.509
 * certificate, and the content must be usable to build a TLS trust store.
 *
 * Never throws — callers are expected to warn and continue.
 */
export function validateCaBundleContent(content: string): FetchCaBundleValidation {
  if (!content.trim()) {
    return { ok: false, reason: "file is empty" };
  }

  const blocks = content.match(PEM_CERTIFICATE_BLOCK);
  if (!blocks || blocks.length === 0) {
    return {
      ok: false,
      reason: "not a valid PEM certificate bundle: no certificate blocks found",
    };
  }

  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch (err: unknown) {
      return {
        ok: false,
        reason: `not a valid PEM certificate bundle: ${(err as Error).message}`,
      };
    }
  }

  try {
    createSecureContext({ ca: content });
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `not a valid PEM certificate bundle: ${(err as Error).message}`,
    };
  }

  return { ok: true };
}

/**
 * Validate a configured fetch.caBundle path: the file must exist, be
 * non-empty, and parse as a PEM certificate bundle.
 *
 * Never throws — callers are expected to warn and continue booting.
 */
export function validateFetchCaBundle(caBundlePath: string): FetchCaBundleValidation {
  let content: string;
  try {
    content = readFileSync(caBundlePath, "utf8");
  } catch (err: unknown) {
    return { ok: false, reason: `cannot read file: ${(err as Error).message}` };
  }

  return validateCaBundleContent(content);
}
