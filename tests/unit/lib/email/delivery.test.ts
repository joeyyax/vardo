import { describe, it, expect } from "vitest";
import { emailDelivery } from "@/lib/email/send";

describe("emailDelivery", () => {
  it("does not claim a send when no provider is configured", () => {
    expect(emailDelivery({ success: true, dev: true })).toEqual({
      sent: false,
      configured: false,
    });
  });

  it("reports a real send", () => {
    expect(emailDelivery({ success: true })).toEqual({ sent: true, configured: true });
  });

  it("reports a provider failure with its reason", () => {
    expect(emailDelivery({ success: false, error: "Resend: 422" })).toEqual({
      sent: false,
      configured: true,
      error: "Resend: 422",
    });
  });
});
