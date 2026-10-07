/** Docker rounds, so a limit within this of the request is the request. */
const TOLERANCE_BYTES = 1024 * 1024;

/** Whether a running container's memory limit disagrees with the app's config. Config is MB, observed is bytes. */
export function memoryLimitDrifted(
  configuredMb: number | null | undefined,
  observedBytes: number | null | undefined,
): boolean {
  // Unset means the tier default applies.
  if (configuredMb == null || configuredMb <= 0) return false;
  // A stopped container reports nothing.
  if (observedBytes == null) return false;

  const expected = configuredMb * 1024 * 1024;
  return Math.abs(expected - observedBytes) > TOLERANCE_BYTES;
}
