import { describe, expect, it } from "vitest";
import { cpuLimitHint } from "@/lib/ui/cpu-limit";
import { cpuLimitSchema } from "@/lib/api/create-app-schema";

describe("CPU limit field (#889)", () => {
  it("says blank uses the tier default and how to remove the cap", () => {
    expect(cpuLimitHint("")).toBe("Blank uses the default for this tier. 0 removes the cap.");
  });

  it("reads 0 as no cap and a number as cores", () => {
    expect(cpuLimitHint("0")).toBe("No CPU cap.");
    expect(cpuLimitHint("1.5")).toBe("1.5 CPU core(s)");
  });

  it("accepts 0 in the API, and nothing below it", () => {
    expect(cpuLimitSchema.safeParse(0).success).toBe(true);
    expect(cpuLimitSchema.safeParse(-1).success).toBe(false);
    expect(cpuLimitSchema.safeParse(65).success).toBe(false);
  });
});
