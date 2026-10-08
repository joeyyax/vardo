import { describe, it, expect } from "vitest";
import { restoreTestFor } from "@/components/backups/history-state";

const run = {
  status: "success",
  storagePath: "a/b.tar.gz",
  verifiedAt: null,
  verifyOutcome: null,
  verifyDetail: null,
};

describe("restoreTestFor", () => {
  it("has nothing to say for rows without an archive", () => {
    expect(restoreTestFor({ ...run, status: "failed" }).kind).toBe("none");
    expect(restoreTestFor({ ...run, storagePath: null }).kind).toBe("none");
  });

  it("separates never tested from tested", () => {
    expect(restoreTestFor(run).kind).toBe("untested");
    expect(
      restoreTestFor({ ...run, verifiedAt: "2026-10-01T00:00:00Z", verifyOutcome: "verified", verifyDetail: "ok" }),
    ).toEqual({ kind: "verified", at: "2026-10-01T00:00:00Z", detail: "ok" });
  });

  it("carries failure detail and unsupported", () => {
    expect(
      restoreTestFor({ ...run, verifiedAt: "x", verifyOutcome: "failed", verifyDetail: "gzip -t failed" }),
    ).toEqual({ kind: "failed", at: "x", detail: "gzip -t failed" });
    expect(restoreTestFor({ ...run, verifyOutcome: "unsupported", verifyDetail: "no drill" }).kind).toBe(
      "unsupported",
    );
  });
});
