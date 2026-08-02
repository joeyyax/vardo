/** Docker rounds, so a limit within this of the request is the request. */
const TOLERANCE_BYTES = 1024 * 1024;

/**
 * Whether a running container's memory limit disagrees with the app's config.
 *
 * `memoryLimit` is MB from the app record, `containerMemoryLimit` is bytes read
 * off the container — comparing them without converting is why a configured
 * 256 MB sitting on an unlimited container never registered.
 */
export function memoryLimitDrifted(
  configuredMb: number | null | undefined,
  observedBytes: number | null | undefined,
): boolean {
  // Nothing configured means the tier default applies; that is not drift.
  if (configuredMb == null || configuredMb <= 0) return false;
  // No observation yet — a stopped container reports nothing to compare.
  if (observedBytes == null) return false;

  const expected = configuredMb * 1024 * 1024;
  return Math.abs(expected - observedBytes) > TOLERANCE_BYTES;
}
