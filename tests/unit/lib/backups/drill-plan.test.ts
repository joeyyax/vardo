import { describe, it, expect } from "vitest";
import {
  judgeDrill,
  judgeArchiveDrill,
  scratchDatabaseFor,
  scratchContainerName,
} from "@/lib/backups/drill-plan";

describe("judgeDrill", () => {
  it("verifies a restore that applied and created structure", () => {
    expect(judgeDrill({ restoreExitCode: 0, objectCount: 42 })).toMatchObject({ outcome: "verified" });
  });

  it("fails a restore that exited non-zero", () => {
    expect(judgeDrill({ restoreExitCode: 3, objectCount: 42 })).toMatchObject({ outcome: "failed" });
  });

  it("fails a clean restore that created nothing — the case this exists to catch", () => {
    // An empty dump applies without error and tells you nothing.
    const verdict = judgeDrill({ restoreExitCode: 0, objectCount: 0 });
    expect(verdict.outcome).toBe("failed");
    expect(verdict.detail).toMatch(/created no tables/);
  });

  it("fails when the restored copy could not be inspected, rather than assuming", () => {
    expect(judgeDrill({ restoreExitCode: 0, objectCount: null })).toMatchObject({ outcome: "failed" });
  });

  it("reports how much was restored, so the number is reviewable", () => {
    expect(judgeDrill({ restoreExitCode: 0, objectCount: 7 }).detail).toContain("7");
  });
});

describe("judgeArchiveDrill", () => {
  it("verifies an archive that extracted files", () => {
    expect(judgeArchiveDrill({ extractExitCode: 0, fileCount: 12 })).toMatchObject({ outcome: "verified" });
  });

  it("fails an archive that extracted nothing", () => {
    expect(judgeArchiveDrill({ extractExitCode: 0, fileCount: 0 })).toMatchObject({ outcome: "failed" });
  });

  it("fails when extraction itself failed", () => {
    expect(judgeArchiveDrill({ extractExitCode: 2, fileCount: null })).toMatchObject({ outcome: "failed" });
  });
});

describe("scratchDatabaseFor — postgres", () => {
  const env = ["POSTGRES_USER=appuser", "POSTGRES_DB=appdb", "POSTGRES_PASSWORD=real-secret"];

  it("mirrors the user and database the dump was taken with", () => {
    // A dump restored under a different name fails on ownership and \connect.
    const plan = scratchDatabaseFor("postgres", "postgres:16", env)!;
    expect(plan.env).toContain("POSTGRES_USER=appuser");
    expect(plan.env).toContain("POSTGRES_DB=appdb");
  });

  it("never reuses the real password", () => {
    const plan = scratchDatabaseFor("postgres", "postgres:16", env)!;
    expect(JSON.stringify(plan)).not.toContain("real-secret");
  });

  it("uses the same image, so a Postgres variant drills against its own build", () => {
    const plan = scratchDatabaseFor("postgres", "tensorchord/pgvecto-rs:pg16-v0.2.0", env)!;
    expect(plan.image).toBe("tensorchord/pgvecto-rs:pg16-v0.2.0");
  });

  it("stops the restore on the first error rather than reporting success", () => {
    expect(scratchDatabaseFor("postgres", "postgres:16", env)!.restoreArgv).toContain("ON_ERROR_STOP=1");
  });

  it("counts only tables the dump would have created", () => {
    const count = scratchDatabaseFor("postgres", "postgres:16", env)!.countArgv.join(" ");
    expect(count).toContain("pg_catalog");
    expect(count).toContain("information_schema");
  });

  it("falls back to the image defaults when the environment says nothing", () => {
    const plan = scratchDatabaseFor("postgres", "postgres:16", [])!;
    expect(plan.env).toContain("POSTGRES_USER=postgres");
    expect(plan.env).toContain("POSTGRES_DB=postgres");
  });
});

describe("scratchDatabaseFor — mysql family", () => {
  it("reads the password inside the container, never on an argv", () => {
    const plan = scratchDatabaseFor("mysql", "mysql:8", ["MYSQL_ROOT_PASSWORD=hunter2"])!;
    expect(plan.restoreArgv.join(" ")).toContain("$MYSQL_ROOT_PASSWORD");
    expect(plan.countArgv.join(" ")).not.toContain("hunter2");
  });

  it("excludes the server's own schemas from the count", () => {
    const count = scratchDatabaseFor("mariadb", "mariadb:11", [])!.countArgv.join(" ");
    expect(count).toContain("performance_schema");
  });

  it("has no plan for engines without one, rather than improvising", () => {
    expect(scratchDatabaseFor("mongo", "mongo:7", [])).toBeNull();
  });
});

describe("scratchContainerName", () => {
  it("is namespaced, so a drill container is recognizable and never collides", () => {
    expect(scratchContainerName("abc123")).toBe("vardo-drill-abc123");
  });
});
