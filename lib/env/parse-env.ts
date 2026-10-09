/** Parses .env content into a key-value map. */
import { parseEnvVars } from "./dotenv";

export function parseEnvToMap(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { key, value } of parseEnvVars(content, "loose")) map[key] = value;
  return map;
}
