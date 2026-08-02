/**
 * Stopping the slot the deploy engine is itself running in.
 *
 * A normal deploy stops the old slot inline. When Vardo deploys Vardo, that
 * slot holds the process writing the deploy log — it dies mid-swap, leaving the
 * deployment stuck `running`, the `current` symlink stale and the container
 * name never updated. The containers were fine; only the bookkeeping was lost.
 *
 * So the stop is handed to a detached container that outlives the process.
 */
const STOP_IMAGE = "docker:cli";

/** Grace period before the old slot goes, long enough to finish post-deploy. */
export const DEFERRED_STOP_DELAY_SECONDS = 20;

/** `docker run` arguments for the detached stopper, or null with nothing to stop. */
export function deferredStopArgs(
  containerIds: string[],
  delaySeconds = DEFERRED_STOP_DELAY_SECONDS,
): string[] | null {
  const ids = containerIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return null;

  return [
    "run", "-d", "--rm",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    STOP_IMAGE,
    "sh", "-c",
    `sleep ${delaySeconds}; docker stop ${ids.join(" ")}`,
  ];
}

/** Container ids from `docker compose ps -q`, one per line. */
export function parseContainerIds(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
