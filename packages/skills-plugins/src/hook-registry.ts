/** Declared extension points for v1 (see shoggoth.json hooks). */
export type HookName = "daemon.startup" | "daemon.shutdown";

export type HookHandler = (ctx?: unknown) => void | Promise<void>;

export class HookRegistry {
  private readonly handlers = new Map<HookName, HookHandler[]>();

  register(name: HookName, handler: HookHandler): void {
    const list = this.handlers.get(name);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(name, [handler]);
    }
  }

  async run(name: HookName, ctx?: unknown): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) {
      await h(ctx);
    }
  }

  /** Clear handlers for a hook (e.g. plugin unload). */
  clear(name: HookName): void {
    this.handlers.delete(name);
  }

  /** Remove every handler registered under a plugin id prefix (v1: per-hook clear only). */
  reset(): void {
    this.handlers.clear();
  }
}
