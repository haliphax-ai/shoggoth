import { DEFAULT_HITL_CONFIG, loadLayeredConfig, type ShoggothConfig } from "@shoggoth/shared";
import { existsSync, watch, type FSWatcher } from "node:fs";
import {
  CONFIG_RESTART_REQUIRED_KEYS,
  type ConfigRestartRequiredKey,
} from "./config-policy";
import { createPolicyEngine, type PolicyEngine } from "./policy/engine";
import { getLogger } from "./logging";

const log = getLogger("config-hot-reload");

type PolicyEngineRef = { engine: PolicyEngine };

export type HitlConfigRef = { value: ShoggothConfig["hitl"] };

/**
 * Keys in {@link CONFIG_RESTART_REQUIRED_KEYS} whose serialized values differ between
 * `prev` and `next`. Empty array means in-process hot reload may apply policy/HITL slices.
 */
export function diffRestartRequiredKeys(
  prev: ShoggothConfig,
  next: ShoggothConfig,
): ConfigRestartRequiredKey[] {
  const changed: ConfigRestartRequiredKey[] = [];
  for (const key of CONFIG_RESTART_REQUIRED_KEYS) {
    const a = (prev as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(key);
    }
  }
  return changed;
}

type StartConfigHotReloadOptions = {
  configDirectory: string;
  /** Snapshot of the last successfully applied layered config (mutated on success). */
  configRef: { current: ShoggothConfig };
  policyRef: PolicyEngineRef;
  hitlRef: HitlConfigRef;
  debounceMs?: number;
  /** When false, skip watch (e.g. `runtime.configHotReload: false` or tests). */
  enabled?: boolean;
};

/**
 * Watch `configDirectory` for changes, reload layered JSON, and apply policy + HITL when
 * no restart-required keys changed. Disable with `SHOGGOTH_CONFIG_HOT_RELOAD=0`.
 */
export function startConfigHotReload(options: StartConfigHotReloadOptions): () => void {
  if (options.enabled === false) {
    return () => {};
  }
  if (process.env.SHOGGOTH_CONFIG_HOT_RELOAD === "0") {
    return () => {};
  }
  const dir = options.configDirectory;
  if (!existsSync(dir)) {
    log.debug("config hot-reload skipped (config directory missing)", { dir });
    return () => {};
  }

  const debounceMs = options.debounceMs ?? 400;
  const { configRef, policyRef, hitlRef } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const apply = (): void => {
    let next: ShoggothConfig;
    try {
      next = loadLayeredConfig(dir);
    } catch (e) {
      log.warn("config hot-reload load failed; keeping previous config", { err: String(e) });
      return;
    }
    const deltas = diffRestartRequiredKeys(configRef.current, next);
    if (deltas.length > 0) {
      log.warn("config file changed but restart-required keys differ; restart daemon to apply", {
        keys: deltas,
      });
      return;
    }
    policyRef.engine = createPolicyEngine(next.policy, next.agents);
    hitlRef.value = { ...DEFAULT_HITL_CONFIG, ...next.hitl };
    configRef.current = next;
    log.info("config hot-reload applied", { slices: ["policy", "hitl"] });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      apply();
    }, debounceMs);
  };

  try {
    watcher = watch(dir, { persistent: false, recursive: true }, () => {
      schedule();
    });
  } catch (e) {
    log.warn("config hot-reload watch failed", { err: String(e) });
    return () => {};
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
