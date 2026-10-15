/** A source that's up but has nothing to report yet, such as a collector before its second collection. */
export class MetricsNotReadyError extends Error {
  override readonly name = "MetricsNotReadyError";
}
