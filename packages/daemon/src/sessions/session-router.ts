export interface SessionRouter {
  register(internalTarget: string, sessionId: string): void;
  unregister(internalTarget: string): void;
  resolve(internalTarget: string): string | undefined;
}

export function createSessionRouter(): SessionRouter {
  const map = new Map<string, string>();
  return {
    register(internalTarget, sessionId) {
      map.set(internalTarget, sessionId);
    },
    unregister(internalTarget) {
      map.delete(internalTarget);
    },
    resolve(internalTarget) {
      return map.get(internalTarget);
    },
  };
}
