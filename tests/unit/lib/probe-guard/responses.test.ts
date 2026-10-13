import { describe, expect, it } from "vitest";
import { HTML_RESPONSE_HEADERS, RESPONSE_HEADERS, errorPage, responseBody, wantsHtml } from "@/lib/probe-guard/responses";

// Anything that would name the app, its stack, versions or Vardo itself.
const REVEALING = /vardo|traefik|next\.?js|node|nginx|apache|docker|postgres|redis|ubuntu|debian|version|v\d+\.\d+|\d+\.\d+\.\d+/i;

/** What a reader sees: the markup, the style block and the title element removed. */
function visibleText(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<title>[\s\S]*?<\/title>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("responseBody", () => {
  it("is the status name as plain text", () => {
    expect(responseBody(403)).toBe("Forbidden\n");
    expect(responseBody(404)).toBe("Not Found\n");
  });

  it("is never cached", () => {
    expect(RESPONSE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(RESPONSE_HEADERS["Content-Type"]).toMatch(/^text\/plain/);
  });
});

describe("errorPage", () => {
  it("names the status and says the item is unavailable", () => {
    const forbidden = errorPage(403);
    expect(forbidden).toContain("<title>403 Forbidden</title>");
    expect(visibleText(forbidden)).toBe("Error 403 Forbidden This item is unavailable.");
    const missing = errorPage(404);
    expect(missing).toContain("<title>404 Not Found</title>");
    expect(visibleText(missing)).toBe("Error 404 Not Found The page you requested is unavailable.");
  });

  it("words a banned address differently from a blocked path", () => {
    expect(visibleText(errorPage(403, { banned: true }))).toBe("Error 403 Forbidden Access from your address is unavailable right now.");
  });

  it("never names the app, its stack or Vardo", () => {
    for (const html of [errorPage(403), errorPage(404), errorPage(429), errorPage(403, { banned: true })]) {
      expect(visibleText(html)).not.toMatch(REVEALING);
    }
  });

  it("loads nothing and runs nothing, so its CSP can stay closed", () => {
    const html = errorPage(403);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|https?:\/\//i);
    expect(HTML_RESPONSE_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(HTML_RESPONSE_HEADERS["Content-Type"]).toMatch(/^text\/html/);
    expect(HTML_RESPONSE_HEADERS["Cache-Control"]).toBe("no-store");
  });

  it("follows the reader's light or dark setting", () => {
    const html = errorPage(403);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("prefers-color-scheme:dark");
  });
});

describe("wantsHtml", () => {
  it("is true for a browser and false for everything else", () => {
    expect(wantsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(wantsHtml("TEXT/HTML")).toBe(true);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml(null)).toBe(false);
  });
});
