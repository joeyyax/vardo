import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  saved: null as Buffer | null,
  published: false,
  on: true,
  file: null as Buffer | null,
}));

vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/auth/admin", () => ({ requireAdminAuth: async () => {} }));
vi.mock("@/lib/trust/view", () => ({ buildTrustView: async () => ({ ok: true }) }));
vi.mock("@/lib/trust/public-load", () => ({ invalidatePublicTrust: () => {}, isPublicOn: async () => h.on }));
vi.mock("@/lib/trust/documents", () => ({
  DPA_ID: "dpa",
  DPA_MAX_BYTES: 1024,
  saveDpa: async (b: Buffer) => { h.saved = b; },
  publishDpa: async () => h.published,
  unpublishDpa: async () => {},
  removeDpa: async () => {},
  reviewPolicy: async () => {},
  unpublishPolicy: async () => {},
  readDpaFile: async (publishedOnly: boolean) => (publishedOnly && !h.published ? null : h.file),
}));

import { POST, PUT } from "@/app/api/v1/admin/trust/documents/[id]/route";
import { GET as publicDpa } from "@/app/api/public/trust/dpa/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const upload = (bytes: string, id = "dpa") => {
  const form = new FormData();
  form.set("file", new File([bytes], "dpa.pdf", { type: "application/pdf" }));
  return PUT(new NextRequest("http://localhost/api/v1/admin/trust/documents/dpa", { method: "PUT", body: form }), ctx(id));
};
const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/v1/admin/trust/documents/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));

beforeEach(() => {
  h.saved = null;
  h.published = false;
  h.on = true;
  h.file = Buffer.from("%PDF-1.7 agreement");
});

describe("agreement upload", () => {
  it("stores a PDF", async () => {
    expect((await upload("%PDF-1.7 hello")).status).toBe(200);
    expect(h.saved?.toString()).toBe("%PDF-1.7 hello");
  });

  it("refuses a file that isn't a PDF, even with a PDF name", async () => {
    expect((await upload("<html>not a pdf</html>")).status).toBe(400);
    expect(h.saved).toBeNull();
  });

  it("refuses a file over the size limit", async () => {
    expect((await upload("%PDF-" + "x".repeat(2000))).status).toBe(400);
    expect(h.saved).toBeNull();
  });

  it("only accepts uploads for the agreement", async () => {
    expect((await upload("%PDF-1.7", "backup")).status).toBe(404);
  });
});

describe("publishing", () => {
  it("won't publish an agreement that wasn't uploaded", async () => {
    expect((await post("dpa", { action: "publish" })).status).toBe(400);
  });

  it("won't publish an empty policy", async () => {
    expect((await post("backup", { action: "publish" })).status).toBe(400);
    expect((await post("backup", { action: "publish", body: "Text." })).status).toBe(200);
  });

  it("404s an unknown document", async () => {
    expect((await post("secrets", { action: "unpublish" })).status).toBe(404);
  });
});

describe("GET /api/public/trust/dpa", () => {
  const get = () => publicDpa(new NextRequest("http://localhost/api/public/trust/dpa", { headers: { host: "acme.example" } }));

  it("serves the agreement once it's published", async () => {
    h.published = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("404s an unpublished agreement", async () => {
    h.published = false;
    expect((await get()).status).toBe(404);
  });

  it("404s when the page isn't public on this host", async () => {
    h.published = true;
    h.on = false;
    expect((await get()).status).toBe(404);
  });
});
