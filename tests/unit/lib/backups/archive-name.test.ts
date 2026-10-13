import { describe, it, expect } from "vitest";
import {
  archiveExtension,
  downloadFileName,
  formatFromArchiveName,
  plainArchiveName,
} from "@/lib/backups/archive-name";

describe("archiveExtension", () => {
  it("marks encrypted archives with .age", () => {
    expect(archiveExtension("tar", true)).toBe("tar.gz.age");
    expect(archiveExtension("dump", true)).toBe("dump.gz.age");
  });

  it("keeps plaintext archives on their plain extension", () => {
    expect(archiveExtension("tar", false)).toBe("tar.gz");
    expect(archiveExtension("dump", false)).toBe("dump.gz");
  });
});

describe("formatFromArchiveName", () => {
  it.each([
    ["acme/web/data/2026-10-09T20-50-17-323Z.tar.gz", "tar"],
    ["acme/web/data/2026-10-09T20-50-17-323Z.tar.gz.age", "tar"],
    ["vardo-system/postgres/2026-10-09T03-00-00-000Z.dump.gz", "dump"],
    ["vardo-system/postgres/2026-10-09T03-00-00-000Z.dump.gz.age", "dump"],
    ["acme/web/data/notes.txt", null],
    ["acme/web/data/x.age", null],
  ])("reads %s as %s", (name, format) => {
    expect(formatFromArchiveName(name)).toBe(format);
  });
});

describe("plainArchiveName", () => {
  it("strips only a trailing .age", () => {
    expect(plainArchiveName("x.tar.gz.age")).toBe("x.tar.gz");
    expect(plainArchiveName("x.tar.gz")).toBe("x.tar.gz");
  });
});

describe("downloadFileName", () => {
  it("names a decrypted download by its format", () => {
    expect(downloadFileName("web-data-2026-10-09", "tar")).toBe("web-data-2026-10-09.tar.gz");
    expect(downloadFileName("postgres-2026-10-09", "dump")).toBe("postgres-2026-10-09.dump.gz");
    expect(downloadFileName("web-data-2026-10-09", null)).toBe("web-data-2026-10-09.tar.gz");
  });
});
