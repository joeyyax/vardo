// Picks the deploy log lines a failure email shows. Lines are already redacted by the deploy logger.

const CONTAINER_LOG = /^\[deploy\]\[(?:crash|unhealthy|logs)\] /;
const NOISE = /^\[(?:timing|stage)\]/;
const ERROR_LINE = /\b(?:error|fatal|panic|exception|incompatible|denied|refused|not found|cannot|failed)\b/i;

/** Container output the health gate captured, prefix stripped. */
export function containerLogLines(lines: string[]): string[] {
  return lines.filter((l) => CONTAINER_LOG.test(l)).map((l) => l.replace(CONTAINER_LOG, ""));
}

/** The last relevant lines: the health gate's container logs when there are any, otherwise the deploy log. */
export function relevantLogTail(lines: string[], max = 20): string[] {
  const container = containerLogLines(lines);
  const source = container.length > 0 ? container : lines.filter((l) => l.trim() && !NOISE.test(l));
  return source.slice(-max);
}

/** The container log line that best explains a crash, e.g. "Error: ... incompatible ...". */
export function crashReason(lines: string[]): string | undefined {
  const container = containerLogLines(lines);
  for (let i = container.length - 1; i >= 0; i--) {
    // Compose prefixes each line with `service-1  | `.
    const text = container[i].replace(/^\S+\s+\|\s?/, "").trim();
    if (text && ERROR_LINE.test(text)) return text.length > 300 ? `${text.slice(0, 299)}…` : text;
  }
  return undefined;
}
