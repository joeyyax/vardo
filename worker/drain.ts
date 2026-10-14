// The worker's drain: stop claiming, let passes, deploys and backup work in flight finish inside the budget.

export type DrainDeps = {
  /** Stops every loop; each finishes its pass in flight and hands back its lease. */
  stopLoops: () => Promise<unknown>;
  /** Holds until backup work in this process finishes, up to the budget. */
  drainBackups: (budgetMs: number) => Promise<unknown>;
  /** Stops claiming deploys and holds until those running here finish, up to the budget. */
  drainDeploys?: (budgetMs: number) => Promise<unknown>;
  budgetMs: number;
};

/** "drained" when everything settled inside the budget, "timeout" when it ran out first. */
export async function drainWork({ stopLoops, drainBackups, drainDeploys, budgetMs }: DrainDeps): Promise<"drained" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
    timer.unref?.();
  });
  const work = Promise.allSettled([drainDeploys?.(budgetMs), stopLoops(), drainBackups(budgetMs)]).then(() => "drained" as const);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
