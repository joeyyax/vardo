import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch: mockFetch }));
vi.mock("@/lib/security/outbound-policy", () => ({ getDomainProbePolicy: async () => ({ allowlist: [] }) }));

import { checkFileExposure } from "@/lib/security/file-exposure";

type Body = string | Uint8Array<ArrayBuffer>;

function respond(status: number, body: Body = "", contentType = "text/plain"): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "content-type": contentType } });
}

/** Serves `files` exactly and `fallback` for every other path. */
function site(files: Record<string, () => Response>, fallback: () => Response = () => respond(404, "Not found")) {
  mockFetch.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    return (files[path] ?? fallback)();
  });
}

const SPA_HTML = `<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div>${"x".repeat(4000)}</body></html>`;
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const DS_STORE: Uint8Array<ArrayBuffer> = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31, 0x00, 0x00, 0x10, 0x00]);

beforeEach(() => site({}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkFileExposure", () => {
  it("returns no findings when every path is a 404", async () => {
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("ignores an SPA that serves its HTML for every path", async () => {
    site({}, () => respond(200, SPA_HTML, "text/html; charset=utf-8"));
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("ignores HTML for a non-HTML file even when it differs from the baseline", async () => {
    site({ "/.env": () => respond(200, "<html><body>a=b</body></html>", "text/html") });
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("ignores an API that answers 401 for every path", async () => {
    site({}, () => respond(401, '{"error":"unauthorized"}', "application/json"));
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("ignores 403 even when the body looks like the file", async () => {
    site({ "/.env": () => respond(403, "SECRET=abc") });
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("ignores a catch-all that returns the same plain text for every path", async () => {
    site({}, () => respond(200, "OK=1"));
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("flags a real .env as critical", async () => {
    site({ "/.env": () => respond(200, "APP_SECRET=abc123\nDATABASE_URL=postgres://u:p@db/app\n") });
    const findings = await checkFileExposure("example.com");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "file-exposure", severity: "critical", detail: "/.env" });
  });

  it("flags a real .env on an SPA whose catch-all is HTML", async () => {
    site(
      { "/.env": () => respond(200, "API_KEY=abc\n", "application/octet-stream") },
      () => respond(200, SPA_HTML, "text/html"),
    );
    const findings = await checkFileExposure("example.com");
    expect(findings.map((f) => f.detail)).toEqual(["/.env"]);
  });

  it("does not flag a .env without KEY=VALUE lines", async () => {
    site({ "/.env": () => respond(200, "not a key value file") });
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("flags a real PEM key", async () => {
    site({ "/server.key": () => respond(200, PEM, "application/x-pem-file") });
    const findings = await checkFileExposure("example.com");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "critical", detail: "/server.key" });
  });

  it("flags a real .DS_Store by its magic bytes", async () => {
    site({ "/.DS_Store": () => respond(200, DS_STORE, "application/octet-stream") });
    const findings = await checkFileExposure("example.com");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", detail: "/.DS_Store" });
  });

  it("does not flag a .DS_Store without the magic bytes", async () => {
    site({ "/.DS_Store": () => respond(200, "hello", "application/octet-stream") });
    expect(await checkFileExposure("example.com")).toEqual([]);
  });

  it("flags .git/config and .git/HEAD by signature", async () => {
    site({
      "/.git/config": () => respond(200, "[core]\n\trepositoryformatversion = 0\n"),
      "/.git/HEAD": () => respond(200, "ref: refs/heads/main\n"),
    });
    const details = (await checkFileExposure("example.com")).map((f) => f.detail).sort();
    expect(details).toEqual(["/.git/HEAD", "/.git/config"]);
  });

  it("flags phpinfo even though it is HTML", async () => {
    site({ "/phpinfo.php": () => respond(200, "<html><body><h1>PHP Version 8.2.1</h1>phpinfo()</body></html>", "text/html") });
    expect((await checkFileExposure("example.com")).map((f) => f.detail)).toEqual(["/phpinfo.php"]);
  });

  it("only reads a bounded prefix of large bodies", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new TextEncoder().encode("A=1\n".repeat(256)));
        if (pulled > 10 * 1024 * 1024) controller.close();
      },
    });
    site({ "/.env": () => new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }) });
    const findings = await checkFileExposure("example.com");
    expect(findings.map((f) => f.detail)).toEqual(["/.env"]);
    expect(pulled).toBeLessThan(64 * 1024);
  });

  it("returns no findings on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await checkFileExposure("example.com")).toEqual([]);
  });
});
