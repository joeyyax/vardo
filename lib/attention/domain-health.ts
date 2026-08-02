/** Consecutive failed checks before a domain counts as unreachable. */
export const DOMAIN_FAILURES_TO_CONFIRM = 2;

/**
 * Whether the recent checks confirm a domain is down.
 *
 * Requires the run to have failed consistently: a domain answering either side
 * of one aborted request is reachable, and reporting it otherwise produces a
 * fault that clears itself before anyone can look.
 *
 * A domain with only one check ever is not confirmed — a first-run blip should
 * not raise an alarm.
 */
export function isConfirmedUnreachable(recent: { reachable: boolean | null }[]): boolean {
  if (recent.length < DOMAIN_FAILURES_TO_CONFIRM) return false;
  return recent
    .slice(0, DOMAIN_FAILURES_TO_CONFIRM)
    .every((check) => check.reachable === false);
}
