// ---------------------------------------------------------------------------
// Vardo deploying Vardo stops the slot running the deploy. The stop has to wait
// until every record is written, or the process dies mid-bookkeeping.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { deferSlotStop } from "@/lib/docker/deploy-steps/swap";

describe("deferSlotStop", () => {
  it("defers for the self-app, whose old slot is running the deploy", () => {
    expect(deferSlotStop(true, "vardo")).toBe(true);
  });

  it("does not defer for any other app", () => {
    expect(deferSlotStop(true, "vardo-preview")).toBe(false);
    expect(deferSlotStop(true, "my-app")).toBe(false);
  });

  it("does not defer when the slots cannot overlap — the stop already happened", () => {
    expect(deferSlotStop(false, "vardo")).toBe(false);
  });
});
