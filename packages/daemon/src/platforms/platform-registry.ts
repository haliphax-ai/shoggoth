import type { PlatformHandle } from "./platform";

const platforms = new Map<string, PlatformHandle>();

export function registerPlatform(id: string, handle: PlatformHandle): void {
  platforms.set(id, handle);
}

export async function stopAllPlatforms(): Promise<void> {
  for (const [, handle] of platforms) {
    await handle.stop();
  }
  platforms.clear();
}
