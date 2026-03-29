/**
 * In-process waiters for HITL pending ids. {@link createPendingActionsStore} hooks call
 * {@link HitlResolutionHub.notifyResolved} after DB updates so the tool loop can resume.
 */
export type HitlResolutionOutcome = "approved" | "denied";

export type HitlResolutionHub = {
  waitFor(id: string): Promise<HitlResolutionOutcome>;
  notifyResolved(id: string, outcome: HitlResolutionOutcome): void;
};

export function createHitlResolutionHub(): HitlResolutionHub {
  const waiters = new Map<string, Array<(v: HitlResolutionOutcome) => void>>();
  const resolvedEarly = new Map<string, HitlResolutionOutcome>();

  return {
    waitFor(id: string): Promise<HitlResolutionOutcome> {
      const early = resolvedEarly.get(id);
      if (early !== undefined) {
        resolvedEarly.delete(id);
        return Promise.resolve(early);
      }
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);
      });
    },

    notifyResolved(id: string, outcome: HitlResolutionOutcome): void {
      const list = waiters.get(id);
      if (list?.length) {
        waiters.delete(id);
        for (const r of list) {
          r(outcome);
        }
        return;
      }
      resolvedEarly.set(id, outcome);
    },
  };
}
