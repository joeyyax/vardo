/** Consecutive failed checks before a domain counts as unreachable. */
export const DOMAIN_FAILURES_TO_CONFIRM = 2;

/** Whether recent checks confirm a domain is down: every check in the run failed, and more than one exists. */
export function isConfirmedUnreachable(recent: { reachable: boolean | null }[]): boolean {
  if (recent.length < DOMAIN_FAILURES_TO_CONFIRM) return false;
  return recent
    .slice(0, DOMAIN_FAILURES_TO_CONFIRM)
    .every((check) => check.reachable === false);
}
