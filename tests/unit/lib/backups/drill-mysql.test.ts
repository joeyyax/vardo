// MySQL restore drill against a real mysql:8.0 scratch container.
// Skips when Docker or the image isn't available locally. Never pulls.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { drillScratchDatabase } from "@/lib/backups/drill";
import { scratchDatabaseFor } from "@/lib/backups/drill-plan";

const IMAGE = "mysql:8.0";

const READY = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!READY)("MySQL drill against real mysql:8.0", () => {
  let dir: string;
  let archive: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vardo-mysql-drill-"));
    archive = join(dir, "backup.tar.gz");
    writeFileSync(
      archive,
      gzipSync(
        "CREATE DATABASE app; USE app; CREATE TABLE notes (id int PRIMARY KEY, body text); " +
          "CREATE TABLE tags (id int); INSERT INTO notes VALUES (1, 'alpha');\n",
      ),
    );
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("restores only after the entrypoint's init phase finishes", async () => {
    const lines: string[] = [];
    const plan = scratchDatabaseFor("mysql", IMAGE, ["MYSQL_ROOT_PASSWORD=real-pw"])!;
    const verdict = await drillScratchDatabase("mysql", plan, archive, (m) => lines.push(m));
    expect(lines.join("\n")).not.toContain("Access denied");
    expect(verdict).toEqual({ outcome: "verified", detail: "2 table(s) restored" });
  }, 240_000);
});
