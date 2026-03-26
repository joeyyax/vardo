/**
 * Update a single key in a .env file. Preserves comments, blank lines, and
 * ordering. If the key already exists, its line is replaced in place. If not,
 * the key=value pair is appended.
 */

import { readFile, writeFile } from "fs/promises";

/**
 * Read the .env file at `filePath`, set `key` to `value`, and write it back.
 * Handles missing files by creating one with only the new key.
 */
export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist — start fresh
  }

  const lines = existing.split("\n");
  const keyPrefix = `${key}=`;
  let found = false;

  const updated = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(keyPrefix) || trimmed === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    // Append — insert a blank separator line when the file doesn't already
    // end with one, then add the new key.
    if (updated.length > 0 && updated[updated.length - 1] !== "") {
      updated.push("");
    }
    updated.push(`${key}=${value}`);
  }

  // Ensure file ends with a single newline
  const content = updated.join("\n").replace(/\n+$/, "") + "\n";
  await writeFile(filePath, content, "utf-8");
}
