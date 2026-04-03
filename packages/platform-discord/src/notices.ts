/**
 * Notice resolver for platform-discord.
 *
 * Delegates to the presentation layer's notice resolver. The daemon registers
 * the real implementation at startup via `setPresentationNoticeResolver`.
 * This module re-exports a thin wrapper so existing platform-discord code
 * can continue calling `daemonNotice(key, vars)` without change.
 */
import type { NoticeResolver } from "./daemon-types";

let _resolver: NoticeResolver | undefined;

/** Register the daemon's notice resolver. Call once during platform startup. */
export function setNoticeResolver(resolver: NoticeResolver): void {
  _resolver = resolver;
}

/** Resolve a notice template. Throws if no resolver has been registered. */
export function daemonNotice(key: string, vars: Record<string, string> = {}): string {
  if (!_resolver) throw new Error("platform-discord: notice resolver not registered; call setNoticeResolver() at startup");
  return _resolver(key, vars);
}
