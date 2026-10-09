// Pulls the failing step's tool output out of BuildKit plain progress.

/** Lines of the failing step kept in the error. */
const TAIL_LINES = 15;

/** Appends the last lines of the failed step (`#14 1.8 ERR_...`) to a build error. */
export function withFailedStepOutput(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const { stdout = "", stderr = "" } = err as Error & { stdout?: unknown; stderr?: unknown };
  const output = `${String(stdout)}\n${String(stderr)}\n${err.message}`.split(/\r?\n|\r/);

  const failed = output.map((l) => /^#(\d+) ERROR\b/.exec(l)?.[1]).find(Boolean);
  if (!failed) return err;

  const prefix = new RegExp(`^#${failed} (\\d+\\.\\d+)\\s?`);
  const lines = output
    .filter((l) => prefix.test(l))
    .map((l) => l.replace(prefix, "").trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return err;

  const tail = lines.slice(-TAIL_LINES);
  err.message = `${err.message}\nFailed step #${failed} output:\n${tail.join("\n")}`;
  return err;
}
