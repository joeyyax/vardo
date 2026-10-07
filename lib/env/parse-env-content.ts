/** Parses `.env` content into key-value pairs, skipping blanks, comments and malformed lines. */
export interface ParsedEnvVar {
  key: string;
  value: string;
}

const ENV_LINE_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvContent(content: string): ParsedEnvVar[] {
  const results: ParsedEnvVar[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const match = line.match(ENV_LINE_REGEX);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2];

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
