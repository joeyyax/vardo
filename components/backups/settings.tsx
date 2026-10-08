"use client";

import { SystemBackupSection } from "./system-backup-section";

/** Admin Backups tab for an admin with no organization: only Vardo's own database applies. */
export function BackupSettings() {
  return <SystemBackupSection />;
}
