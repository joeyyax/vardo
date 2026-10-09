/** Parses `.env` content into key-value pairs, skipping blanks, comments and malformed lines. */
import { parseEnvVars, type ParsedEnvVar } from "./dotenv";

export type { ParsedEnvVar };

export function parseEnvContent(content: string): ParsedEnvVar[] {
  return parseEnvVars(content, "strict");
}
