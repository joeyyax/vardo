// URL job headers are stored encrypted and only ever leave the server masked.

process.env.ENCRYPTION_MASTER_KEY ??= "d".repeat(64);

import { describe, it, expect } from "vitest";
import { decryptHeaders, encryptHeaders, maskHeaders, mergeHeaders } from "@/lib/cron/headers";
import { serializeCronJob, urlColumns, CronInputError } from "@/lib/cron/jobs";
import { HEADER_MASK } from "@/lib/cron/url-options";

const headers = [{ name: "Authorization", value: "Bearer s3cret-token-value" }];

describe("cron headers", () => {
  it("round-trips through encryption without plaintext at rest", () => {
    const stored = encryptHeaders(headers, "org-1")!;
    expect(stored).not.toContain("s3cret");
    expect(decryptHeaders(stored, "org-1")).toEqual(headers);
  });

  it("can't be read with another org's key", () => {
    const stored = encryptHeaders(headers, "org-1")!;
    expect(() => decryptHeaders(stored, "org-2")).toThrow();
  });

  it("stores nothing for an empty list", () => {
    expect(encryptHeaders([], "org-1")).toBeNull();
  });

  it("masks values for output", () => {
    expect(maskHeaders(encryptHeaders(headers, "org-1"), "org-1")).toEqual([{ name: "Authorization", value: HEADER_MASK }]);
  });

  it("serializes a job with masked headers only", () => {
    const job = serializeCronJob({ id: "c1", organizationId: "org-1", headers: encryptHeaders(headers, "org-1") });
    expect(JSON.stringify(job)).not.toContain("s3cret");
    expect(JSON.stringify(job)).not.toContain("enc:v1");
    expect(job.headers).toEqual([{ name: "Authorization", value: HEADER_MASK }]);
  });

  it("keeps a stored value when the client sends the mask or nothing", () => {
    expect(mergeHeaders([{ name: "authorization", value: HEADER_MASK }], headers)).toEqual([
      { name: "authorization", value: "Bearer s3cret-token-value" },
    ]);
    expect(mergeHeaders([{ name: "Authorization" }], headers)[0].value).toBe("Bearer s3cret-token-value");
    expect(mergeHeaders([{ name: "Authorization", value: "new" }], headers)[0].value).toBe("new");
  });

  it("refuses a new header with no value", () => {
    expect(() => urlColumns({ headers: [{ name: "X-New" }] }, "org-1", null)).toThrow(CronInputError);
  });
});
