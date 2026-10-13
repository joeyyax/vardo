#!/usr/bin/env tsx
/**
 * Print the age secret key every backup archive is encrypted to. Anyone holding it can read the archives.
 *
 * Usage:
 *   vardo backup key > key.txt
 *   age -d -i key.txt archive.tar.gz.age | tar -xz
 */

import { deriveArchiveIdentity } from "../lib/backups/archive-identity";

export function main(argv: string[], env: { ENCRYPTION_MASTER_KEY?: string }): number {
  if (argv.length > 0) {
    console.error("Usage: vardo backup key > key.txt");
    return 2;
  }
  if (!env.ENCRYPTION_MASTER_KEY) {
    console.error("ENCRYPTION_MASTER_KEY is not set.");
    return 2;
  }
  console.log(deriveArchiveIdentity(env.ENCRYPTION_MASTER_KEY));
  return 0;
}

if (process.argv[1] && /backup-key\.[cm]?[jt]s$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2), { ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY }));
}
