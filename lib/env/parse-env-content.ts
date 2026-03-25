/**
 * Parse a raw `.env` format string into structured key-value pairs.
 *
 * Rules:
 * - Blank lines are skipped
 * - Lines starting with `#` (with optional leading whitespace) are skipped
 * - Lines must match `KEY=value` format
 * - Surrounding single or double quotes on values are stripped
 * - Keys must be valid env var names: start with a letter or underscore,
 *   followed by letters, digits, or underscores
 */
export interface ParsedEnvVar {
  key: string;
  value: string;
}

const ENV_LINE_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvContent(content: string): ParsedEnvVar[] {
  const results: ParsedEnvVar[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const match = line.match(ENV_LINE_REGEX);
    if (!match) {
      continue; // Skip malformed lines
    }

    const key = match[1];
    let value = match[2];

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    results.push({ key, value });
  }

  return results;
}
