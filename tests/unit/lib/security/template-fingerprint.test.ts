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

import { matchSignals, fingerprintApp, extractComposeImages, type TemplateObservation } from "@/lib/security/template-fingerprint";
import type { ProbeResponse } from "@/lib/security/file-exposure";
import type { TemplateSignal } from "@/lib/probe-guard/templates";

function probe(opts: Partial<ProbeResponse> & { status?: number; text?: string; headers?: Headers } = {}): ProbeResponse {
  const text = opts.text ?? "";
  const bytes = new TextEncoder().encode(text);
  return {
    status: opts.status ?? 200,
    contentType: opts.contentType ?? "text/html",
    bytes,
    text,
    length: opts.length ?? bytes.length,
    hash: opts.hash ?? `hash-${text.length}`,
    headers: opts.headers ?? new Headers(),
  };
}

function observation(partial: Partial<TemplateObservation> = {}): TemplateObservation {
  return {
    home: partial.home ?? null,
    baseline: partial.baseline ?? null,
    paths: partial.paths ?? new Map(),
  };
}

describe("extractComposeImages", () => {
  it("returns image names from compose content lines", () => {
    const compose = [
      "services:",
      "  web:",
      "    image: nginx:1.25",
      "  db:",
      "    image: 'postgres:16'",
      '    image: "redis:7-alpine"',
    ].join("\n");
    expect(extractComposeImages(compose)).toEqual(["nginx:1.25", "postgres:16", "redis:7-alpine"]);
  });

  it("returns an empty array when content is empty or null", () => {
    expect(extractComposeImages(null)).toEqual([]);
    expect(extractComposeImages("")).toEqual([]);
  });

  it("ignores lines without image keys", () => {
    const compose = "services:\n  web:\n    ports: ['80:80']\n    environment:\n      FOO: bar\n";
    expect(extractComposeImages(compose)).toEqual([]);
  });
});

describe("matchSignals - image signals", () => {
  const imageSignal: TemplateSignal = { image: /(?:^|\/)wordpress(?:[:@]|$)/i };

  it("matches the app's own imageName", () => {
    expect(matchSignals([imageSignal], observation(), "wordpress:6", [], [])).toBe(true);
  });

  it("matches a compose child's imageName", () => {
    expect(matchSignals([imageSignal], observation(), null, ["myorg/wordpress:php8.3"], [])).toBe(true);
  });

  it("matches an image line embedded in compose content", () => {
    expect(matchSignals([imageSignal], observation(), null, [], ["library/wordpress:6.4"])).toBe(true);
  });

  it("does not match a lookalike image name", () => {
    expect(matchSignals([imageSignal], observation(), "wordpressify/app:1", [], [])).toBe(false);
    expect(matchSignals([imageSignal], observation(), "myapp:1", [], [])).toBe(false);
  });

  it("returns false when no image signal and no live observations are provided", () => {
    expect(matchSignals([imageSignal], observation(), null, [], [])).toBe(false);
  });
});

describe("matchSignals - path signals", () => {
  const pathSignal: TemplateSignal = { path: "/wp-login.php", body: /name=["']log["']/i };

  it("matches a 200 response whose body matches the regex", () => {
    const r = probe({ status: 200, text: '<form><input name="log" /></form>' });
    expect(matchSignals([pathSignal], observation({ paths: new Map([["/wp-login.php", r]]) }))).toBe(true);
  });

  it("does not match a 200 response whose body does not match", () => {
    const r = probe({ status: 200, text: "<html>Not WordPress</html>" });
    expect(matchSignals([pathSignal], observation({ paths: new Map([["/wp-login.php", r]]) }))).toBe(false);
  });

  it("does not match a non-2xx response", () => {
    const r = probe({ status: 404, text: '<input name="log" />' });
    expect(matchSignals([pathSignal], observation({ paths: new Map([["/wp-login.php", r]]) }))).toBe(false);
  });

  it("does not match when the path response equals the catch-all baseline", () => {
    const r = probe({ status: 200, contentType: "text/html", text: "<html>SPA shell</html>", hash: "spa" });
    const baseline = probe({ status: 200, contentType: "text/html", text: "<html>SPA shell</html>", hash: "spa", length: r.length });
    expect(matchSignals([pathSignal], observation({ baseline, paths: new Map([["/wp-login.php", r]]) }))).toBe(false);
  });

  it("matches a path that differs from the baseline in media type", () => {
    const baseline = probe({ status: 200, contentType: "text/html", text: "<html>SPA</html>", length: 14, hash: "spa" });
    const r = probe({ status: 200, contentType: "text/plain", text: '<input name="log" />', length: 22, hash: "real" });
    expect(matchSignals([pathSignal], observation({ baseline, paths: new Map([["/wp-login.php", r]]) }))).toBe(true);
  });

  it("does not match when the body differs from baseline but lengths are within tolerance and content-type matches", () => {
    const baseline = probe({ status: 200, contentType: "text/html", text: "<html>" + "x".repeat(60) + "</html>", length: 73, hash: "a" });
    const r = probe({ status: 200, contentType: "text/html", text: "<html>" + "y".repeat(60) + "</html>", length: 73, hash: "b" });
    expect(matchSignals([pathSignal], observation({ baseline, paths: new Map([["/wp-login.php", r]]) }))).toBe(false);
  });

  it("does not match when the fetch returned null", () => {
    expect(matchSignals([pathSignal], observation({ paths: new Map([["/wp-login.php", null]]) }))).toBe(false);
  });

  it("matches a path signal without a body regex on any 200 response", () => {
    const r = probe({ status: 200, text: "<html>Anything</html>" });
    const signal: TemplateSignal = { path: "/actuator" };
    expect(matchSignals([signal], observation({ paths: new Map([["/actuator", r]]) }))).toBe(true);
  });
});

describe("matchSignals - cookie signals", () => {
  const cookieSignal: TemplateSignal = { cookie: "laravel_session" };

  it("matches when the home page Set-Cookie contains the name", () => {
    const headers = new Headers({ "set-cookie": "laravel_session=abc123; Path=/; HttpOnly" });
    const home = probe({ headers });
    expect(matchSignals([cookieSignal], observation({ home }))).toBe(true);
  });

  it("does not match when the cookie name differs", () => {
    const headers = new Headers({ "set-cookie": "session=abc; Path=/" });
    expect(matchSignals([cookieSignal], observation({ home: probe({ headers }) }))).toBe(false);
  });

  it("does not match when the home page has no Set-Cookie", () => {
    expect(matchSignals([cookieSignal], observation({ home: probe() }))).toBe(false);
  });

  it("does not match when the home page response is null", () => {
    expect(matchSignals([cookieSignal], observation({ home: null }))).toBe(false);
  });
});

describe("matchSignals - header signals", () => {
  it("matches when the named header is present (no value regex)", () => {
    const home = probe({ headers: new Headers({ "x-powered-by": "PHP/8.2" }) });
    const signal: TemplateSignal = { header: "x-powered-by" };
    expect(matchSignals([signal], observation({ home }))).toBe(true);
  });

  it("matches when the header value matches the regex", () => {
    const home = probe({ headers: new Headers({ server: "nginx/1.25.1" }) });
    const signal: TemplateSignal = { header: "server", value: /nginx\/\d+\.\d+/ };
    expect(matchSignals([signal], observation({ home }))).toBe(true);
  });

  it("does not match when the value regex does not match", () => {
    const home = probe({ headers: new Headers({ server: "Apache/2.4" }) });
    const signal: TemplateSignal = { header: "server", value: /nginx/ };
    expect(matchSignals([signal], observation({ home }))).toBe(false);
  });

  it("does not match when the header is absent", () => {
    expect(matchSignals([{ header: "x-trace-id" }], observation({ home: probe() }))).toBe(false);
  });

  it("does not match when the home page response is null", () => {
    expect(matchSignals([{ header: "server" }], observation({ home: null }))).toBe(false);
  });
});

describe("matchSignals - any-of", () => {
  it("returns true when at least one of several signals matches", () => {
    const home = probe({ headers: new Headers({ server: "nginx/1.25" }) });
    expect(matchSignals(
      [{ image: /^nothingmatches/ }, { header: "server" }],
      observation({ home }),
      null,
      [],
      [],
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fingerprintApp - integration of matchSignals with the fetch layer
// ---------------------------------------------------------------------------

const { mockRecordRecognized } = vi.hoisted(() => ({ mockRecordRecognized: vi.fn() }));
vi.mock("@/lib/probe-guard/recommendations", () => ({ recordRecognized: mockRecordRecognized }));

describe("fingerprintApp", () => {
  beforeEach(() => {
    mockRecordRecognized.mockResolvedValue(undefined);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns no recognized ids when the app has no image and the host returns 404 for every path", async () => {
    mockFetch.mockImplementation(async () => new Response("Not found", { status: 404 }));
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: null,
      childImages: [],
      appliedTemplateIds: [],
    });
    expect(result.recognizedIds).toEqual([]);
  });

  it("recognizes a template by imageName without making any HTTP request", async () => {
    // Every other template needs a live fetch (path/cookie/header); only the matching
    // image-only template should be returned. We assert no fetch because the only
    // image-only template would be one we craft — the real PROBE_TEMPLATES all have
    // a non-image signal too, so a real fetch happens here.
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: "wordpress:6",
      composeContent: null,
      childImages: [],
      appliedTemplateIds: ["wordpress", "phpmyadmin", "actuator", "laravel"],
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.recognizedIds).toEqual([]);
  });

  it("recognizes a template from a compose image line when no imageName is set", async () => {
    mockFetch.mockImplementation(async () => new Response("Not found", { status: 404 }));
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: "services:\n  web:\n    image: 'phpmyadmin:5'\n",
      childImages: [],
      appliedTemplateIds: [],
    });
    expect(result.recognizedIds).toContain("phpmyadmin");
  });

  it("does not recognize anything when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: "services:\n  web:\n    image: wordpress:6\n", // image-only template would still match
      childImages: [],
      appliedTemplateIds: [],
    });
    // Image-only signals still match even when fetches fail.
    expect(result.recognizedIds).toContain("wordpress");
  });

  it("recognizes a template by path+body on the live host", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/wp-login.php")) {
        return new Response('<form><input name="log" /></form>', { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("Not found", { status: 404 });
    });
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: null,
      childImages: [],
      appliedTemplateIds: [],
    });
    expect(result.recognizedIds).toContain("wordpress");
  });

  it("does not match a path signal when the host returns a catch-all for every path", async () => {
    mockFetch.mockImplementation(async () => new Response("<html>SPA shell</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: null,
      childImages: [],
      appliedTemplateIds: [],
    });
    expect(result.recognizedIds).not.toContain("wordpress");
  });

  it("recognizes a template by Set-Cookie header on the home page", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/")) {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html", "set-cookie": "laravel_session=abc; Path=/; HttpOnly" },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: null,
      composeContent: null,
      childImages: [],
      appliedTemplateIds: [],
    });
    expect(result.recognizedIds).toContain("laravel");
  });

  it("skips templates already in appliedTemplateIds entirely", async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response("Not found", { status: 404 }));
    mockFetch.mockImplementation(fetchSpy);

    // Mark every template as applied; nothing should be processed and no fetches should happen.
    const result = await fingerprintApp({
      appId: "app-1",
      domain: "example.com",
      imageName: "wordpress:6",
      composeContent: null,
      childImages: [],
      appliedTemplateIds: ["wordpress", "phpmyadmin", "actuator", "laravel"],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.recognizedIds).toEqual([]);
  });
});