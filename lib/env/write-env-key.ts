/** Sets one key in a .env file, in place or appended, preserving everything else. */

import { readFile, writeFile } from "fs/promises";

/** Sets `key` to `value` in the .env at `filePath`, creating the file if missing. */
export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // Missing file: start fresh.
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
    if (updated.length > 0 && updated[updated.length - 1] !== "") {
      updated.push("");
    }
    updated.push(`${key}=${value}`);
  }

  const content = updated.join("\n").replace(/\n+$/, "") + "\n";
  await writeFile(filePath, content, "utf-8");
}
