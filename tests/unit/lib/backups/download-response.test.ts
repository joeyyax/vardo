import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { downloadBackupToTemp } = vi.hoisted(() => ({ downloadBackupToTemp: vi.fn() }));
vi.mock("@/lib/backups/engine", () => ({
  getBackupDownloadUrl: async () => null,
  downloadBackupToTemp,
}));

import { backupDownloadResponse } from "@/lib/backups/download-response";
import { DOWNLOAD_HINT } from "@/lib/backups/archive-name";

describe("backupDownloadResponse", () => {
  it("streams the decrypted archive with the decrypt hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vardo-download-"));
    const file = join(dir, "backup.tar.gz");
    writeFileSync(file, "plain");
    downloadBackupToTemp.mockResolvedValue(file);

    const res = await backupDownloadResponse("bk-1", "web-data-2026-10-09.tar.gz");

    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="web-data-2026-10-09.tar.gz"');
    expect(res.headers.get("X-Vardo-Archive")).toBe(DOWNLOAD_HINT);
    expect(DOWNLOAD_HINT).toContain("vardo backup decrypt <in> <out>");
    expect(await res.text()).toBe("plain");
  });
});
