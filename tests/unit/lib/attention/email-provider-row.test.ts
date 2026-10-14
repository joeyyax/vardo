import { describe, expect, it } from "vitest";
import { emailProviderRows } from "@/lib/attention/email-provider-row";

describe("emailProviderRows", () => {
  it("warns when no email provider is configured and links to email settings", () => {
    const [row] = emailProviderRows(false);
    expect(row.tone).toBe("warning");
    expect(row.items[0].name).toBe("No email provider configured");
    expect(row.items[0].href).toBe("/admin/settings/email");
  });

  it("shows nothing once a provider is configured", () => {
    expect(emailProviderRows(true)).toEqual([]);
  });
});
