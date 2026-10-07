#!/usr/bin/env tsx
/**
 * Decrypt a backup archive with only the file and ENCRYPTION_MASTER_KEY.
 *
 * Usage:
 *   ENCRYPTION_MASTER_KEY=... tsx scripts/backup-decrypt.ts <in> <out>
 *   vardo backup decrypt <in> <out>  (via wrapper script)
 */

import { decryptArchiveFile } from "../lib/backups/archive-crypto";

export async function main(argv: string[], env: { ENCRYPTION_MASTER_KEY?: string }): Promise<number> {
  const [input, output] = argv;
  if (!input || !output || argv.length !== 2) {
    console.error("Usage: vardo backup decrypt <in> <out>");
    return 2;
  }
  if (input === output) {
    console.error("Write the output to a different path than the input.");
    return 2;
  }
  const masterKey = env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    console.error("ENCRYPTION_MASTER_KEY is not set.");
    return 2;
  }

  try {
    const { encrypted } = await decryptArchiveFile(input, output, masterKey);
    console.log(encrypted ? `Decrypted ${input} to ${output}` : `${input} is not encrypted; copied to ${output}`);
    return 0;
  } catch (err) {
    console.error(`Decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
    const { rm } = await import("fs/promises");
    await rm(output, { force: true }).catch(() => {});
    return 1;
  }
}

if (process.argv[1] && /backup-decrypt\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2), { ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY }).then((code) => process.exit(code));
}
