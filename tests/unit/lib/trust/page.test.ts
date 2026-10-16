import { describe, expect, it } from "vitest";
import { renderBody, renderTrustPage } from "@/lib/trust/page";
import { toPublic, type PublicInput } from "@/lib/trust/public";
import { manualHosting } from "@/lib/trust/hosting";

const NOW = new Date("2026-10-16T12:00:00Z");

const base: PublicInput = {
  name: "Acme",
  securityContact: "security@acme.example",
  hosting: manualHosting({ provider: "hetzner", region: "nbg1" }),
  results: [
    { id: "nightly-backups", state: "passing", evidence: "LEAK-evidence 17 of 17 jobs", checkedAt: new Date("2026-10-16T10:00:00Z") },
    { id: "https", state: "failing", evidence: "LEAK-domain internal.client.example", checkedAt: NOW },
  ],
  commitments: [
    { label: "Uptime", value: "99.9% monthly", enabled: true },
    { label: "LEAK-off-commitment", value: "1 hour", enabled: false },
  ],
  subprocessors: [
    { name: "Confirmed Co", purpose: "Email", region: "US", status: "confirmed" },
    { name: "LEAK-suggested", purpose: "Backups", region: null, status: "suggested" },
  ],
  policies: [
    { id: "backup", title: "Backup policy", reviewedBody: "Reviewed text.", reviewedAt: new Date("2026-10-01T00:00:00Z") },
    { id: "access", title: "LEAK-draft-policy", reviewedBody: null, reviewedAt: null },
  ],
  dpa: null,
};

describe("renderTrustPage", () => {
  const html = renderTrustPage(toPublic(base), NOW);

  it("renders approved content", () => {
    expect(html).toContain("Acme");
    expect(html).toContain("Nightly backups completing");
    expect(html).toContain("checked 2 hours ago");
    expect(html).toContain("99.9% monthly");
    expect(html).toContain("Confirmed Co");
    expect(html).toContain("Reviewed text.");
    expect(html).toContain("Hosted on infrastructure certified to ISO/IEC 27001");
  });

  it("leaks nothing that isn't approved or passing", () => {
    expect(html).not.toContain("LEAK");
  });

  it("shows no score, band or counts", () => {
    expect(html).not.toMatch(/score|band|points|passing|failing|\d+ of \d+/i);
  });

  it("has no scripts and no third-party requests", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(?:src|href)="https?:\/\/(?!cdn\.hetzner\.com)/);
  });

  it("escapes operator text", () => {
    const evil = renderTrustPage(toPublic({ ...base, name: `<img src=x onerror=alert(1)>`, subprocessors: [{ name: `"><b>x</b>`, purpose: "p", region: null, status: "confirmed" }] }), NOW);
    expect(evil).not.toContain("<img src=x");
    expect(evil).not.toContain("<b>x</b>");
  });

  it("omits a section with nothing approved", () => {
    const empty = renderTrustPage(toPublic({ ...base, commitments: [], subprocessors: [], policies: [], results: [] }), NOW);
    expect(empty).not.toContain('id="commitments"');
    expect(empty).not.toContain('id="subprocessors"');
    expect(empty).not.toContain('id="documents"');
    expect(empty).not.toContain('id="controls"');
  });
});

describe("renderBody", () => {
  it("renders paragraphs, bullets and headings, escaped", () => {
    const out = renderBody("## Title\n\nFirst <b>line</b>\nsecond\n\n- one\n- two");
    expect(out).toBe("<h4>Title</h4><p>First &lt;b&gt;line&lt;/b&gt;<br>second</p><ul><li>one</li><li>two</li></ul>");
  });

  it("renders a heading directly followed by text or a list, as generated policies write them", () => {
    const out = renderBody("## Storage\n- Encrypted\n- Off the host\n\n## Retention\nKept for 30 days.");
    expect(out).toBe("<h4>Storage</h4><ul><li>Encrypted</li><li>Off the host</li></ul><h4>Retention</h4><p>Kept for 30 days.</p>");
    expect(out).not.toContain("##");
    expect(out).not.toContain("- ");
  });

  it("escapes script tags in a body", () => {
    const out = renderBody("## <script>alert(1)</script>\n- <script>x</script>\n<script>y</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders every generated policy without leftover markup", async () => {
    const { generatePolicy } = await import("@/lib/trust/policies");
    for (const id of ["backup", "access", "incident"] as const) {
      const html = renderBody(
        generatePolicy(id, {
          name: "Joey Yax",
          backup: { jobs: true, recoveryPointHours: 24, retentionDays: 30, offHost: true, encrypted: true },
          access: { methods: ["passkey", "password"], registration: "closed", sessionDays: 7 },
          incident: { securityContact: "s@x.example", breachNotification: "Within 72 hours", email: true, backupFailureAlerts: true },
        }),
      );
      expect(html).not.toMatch(/##|<p>- |<br>- /);
    }
  });
});
