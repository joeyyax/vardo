import { describe, expect, it } from "vitest";
import { middleSplit } from "@/lib/ui/middle-truncate";

describe("middleSplit", () => {
  it("leaves short names whole", () => {
    expect(middleSplit("Plain deploy")).toEqual({ head: "Plain deploy", tail: "" });
    expect(middleSplit("api")).toEqual({ head: "api", tail: "" });
  });

  it("keeps a short last word as the tail, the space with the head", () => {
    expect(middleSplit("Invoice renderer service")).toEqual({ head: "Invoice renderer ", tail: "service" });
  });

  it("keeps the last six characters when the last word is long", () => {
    expect(middleSplit("Customer notifications")).toEqual({ head: "Customer notific", tail: "ations" });
  });

  it("splits a name with no spaces on characters", () => {
    const { head, tail } = middleSplit("payments-reconciliation-worker");
    expect(tail).toBe("worker");
    expect(head + tail).toBe("payments-reconciliation-worker");
    expect(middleSplit("averyveryverylongname")).toEqual({ head: "averyveryverylo", tail: "ngname" });
  });

  it("always joins back to the name", () => {
    for (const name of ["Second deploy waits", "a b c d e f g h i j k", "x".repeat(40)]) {
      const { head, tail } = middleSplit(name);
      expect(head + tail).toBe(name);
    }
  });
});
