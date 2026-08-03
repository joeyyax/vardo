// Outcome summary for bulk actions that fire one request per app. System-managed
// apps refuse some verbs, so a mixed result is routine and has to be named.

export type BulkOutcome = {
  tone: "success" | "warning" | "error";
  message: string;
  description?: string;
};

const MAX_NAMED = 3;

/** "a, b, c and 2 more" */
function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED) {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, MAX_NAMED).join(", ")} and ${names.length - MAX_NAMED} more`;
}

/**
 * Summarize a per-app bulk run.
 *
 * @param verb - present tense, e.g. "stop"
 * @param past - past tense, e.g. "stopped"
 */
export function summarizeBulkResult(opts: {
  verb: string;
  past: string;
  total: number;
  failed: string[];
}): BulkOutcome {
  const { verb, past, total, failed } = opts;
  const succeeded = total - failed.length;

  if (failed.length === 0) {
    return { tone: "success", message: `All apps ${past}` };
  }

  if (succeeded === 0) {
    return {
      tone: "error",
      message: total === 1 ? `Could not ${verb} ${failed[0]}` : `Could not ${verb} any apps`,
      description: total === 1 ? undefined : nameList(failed),
    };
  }

  return {
    tone: "warning",
    message: `${succeeded} of ${total} apps ${past}`,
    description: `Failed: ${nameList(failed)}`,
  };
}
