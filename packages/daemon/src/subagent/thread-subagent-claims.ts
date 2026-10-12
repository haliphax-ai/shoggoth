/**
 * Control-plane spawn claims for platform threads.
 *
 * A Discord `THREAD_CREATE` gateway event carries no signal distinguishing a thread the
 * operator's `subagent_spawn` op just created from a thread a user created — so the
 * thread-subagent autocreate routine would race the spawn op for the same thread and, on
 * losing the binding, leave a banner-only zombie session behind. The spawn flow therefore
 * claims its target thread *before* the thread can exist; `handlePlatformThreadCreate`
 * then skips the event with a distinct reason instead of spawning a competing session.
 *
 * Two claim shapes, both synchronous (registration must not await an event that may
 * already be queued):
 * - An **explicit thread id** claim (`spawn_persistent` with a concrete `platform_thread_id`).
 * - A **pending creation** claim keyed by parent channel, registered *before* the spawn op
 *   creates the thread via REST: for the `thread_id: "0"` auto-create sentinel the id is
 *   unknown until that call returns, but the gateway event may be dispatched first.
 *
 * Claims are released on every spawn exit path (success, thrown error, bind conflict), so
 * a failed spawn never leaves a poisoned claim behind; tests reset the registry through
 * `clearThreadSpawnClaims`.
 */

const claimedThreadIds = new Set<string>();
/** Parent channel id → pending auto-create claims (refcounted for concurrent spawns). */
const pendingCreationsByChannel = new Map<string, number>();

/**
 * Claim a concrete thread id for the control-plane spawn flow.
 * Exclusive: a second claim on the same id throws (the caller surfaces it as an op error).
 * Returns a release function (idempotent).
 */
export function claimPlatformThreadIdForSpawn(threadId: string): () => void {
  const id = threadId.trim();
  if (!id) return () => {};
  if (claimedThreadIds.has(id)) {
    throw new Error(`thread ${id} is already claimed by another in-flight spawn`);
  }
  claimedThreadIds.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claimedThreadIds.delete(id);
  };
}

/**
 * Register intent to create a thread in `parentChannelId` (the `thread_id: "0"` sentinel
 * path). Refcounted: each call must pair with the returned release. Registered before the
 * REST create call so a THREAD_CREATE event dispatched in between is recognized.
 */
export function claimPendingThreadCreationForSpawn(parentChannelId: string): () => void {
  const channel = parentChannelId.trim();
  if (!channel) return () => {};
  pendingCreationsByChannel.set(channel, (pendingCreationsByChannel.get(channel) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (pendingCreationsByChannel.get(channel) ?? 0) - 1;
    if (next > 0) pendingCreationsByChannel.set(channel, next);
    else pendingCreationsByChannel.delete(channel);
  };
}

/**
 * True when the thread-create event belongs to a control-plane spawn (claimed by an
 * in-flight `subagent_spawn`): the spawn op's own session will bind the thread, so the
 * autocreate routine must not spawn a competing session.
 */
export function isThreadClaimedByControlPlaneSpawn(input: {
  readonly threadId: string;
  readonly parentChannelId: string;
}): boolean {
  const threadId = input.threadId.trim();
  if (threadId && claimedThreadIds.has(threadId)) return true;
  const parentChannelId = input.parentChannelId.trim();
  return Boolean(parentChannelId && pendingCreationsByChannel.has(parentChannelId));
}

/** Reset the registry (tests only). */
export function clearThreadSpawnClaims(): void {
  claimedThreadIds.clear();
  pendingCreationsByChannel.clear();
}
