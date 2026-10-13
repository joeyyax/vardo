import { describe, expect, it } from "vitest";
import { HTML_RESPONSE_HEADERS, RESPONSE_HEADERS, bannedMessage, errorPage, responseBody, wantsHtml } from "@/lib/probe-guard/responses";

// Anything that would name the app, its stack, versions or Vardo itself.
const REVEALING = /vardo|traefik|next\.?js|node|nginx|apache|docker|postgres|redis|ubuntu|debian|version|v\d+\.\d+|\d+\.\d+\.\d+/i;

/** What a reader sees: markup, style and title removed. */
function visibleText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<\/?(?:p|h1|main)\b[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

describe("bannedMessage", () => {
  const now = new Date("2026-10-13T04:00:00Z");
  const after = (ms: number) => new Date(now.getTime() + ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it.each([
    [18 * HOUR, "until 22:00 UTC (about 18 hours)."],
    [23 * HOUR, "until Oct 14, 03:00 UTC (about 23 hours)."],
    [30_000, "until 04:00 UTC (about a minute)."],
    [45 * MIN, "until 04:45 UTC (about 45 minutes)."],
    [60 * MIN, "until 05:00 UTC (about an hour)."],
    [30 * HOUR, "until Oct 14, 10:00 UTC (about 30 hours)."],
    [72 * HOUR, "until Oct 16, 04:00 UTC (about 3 days)."],
  ])("ends %i ms out: %s", (ms, tail) => {
    expect(bannedMessage(after(ms), now)).toBe(`Access from your address is unavailable ${tail}`);
  });

  it("includes the date once the end falls on another UTC day", () => {
    expect(bannedMessage(new Date("2026-10-13T23:30:00Z"), now)).toContain("until 23:30 UTC");
    expect(bannedMessage(new Date("2026-10-14T00:30:00Z"), now)).toContain("until Oct 14, 00:30 UTC");
  });

  it("says a permanent ban has no end date", () => {
    expect(bannedMessage(new Date("9999-12-31T00:00:00.000Z"), now)).toBe("Access from your address is unavailable, and there is no end date.");
  });

  it("falls back to the generic line without a usable end", () => {
    const generic = "Access from your address is unavailable right now.";
    expect(bannedMessage(undefined, now)).toBe(generic);
    expect(bannedMessage(now, now)).toBe(generic);
    expect(bannedMessage(after(-MIN), now)).toBe(generic);
  });
});

describe("errorPage", () => {
  it("names the status and says the item is unavailable", () => {
    const forbidden = errorPage(403);
    expect(forbidden).toContain("<title>403 Forbidden</title>");
    expect(visibleText(forbidden)).toBe("error: 403 Forbidden This item is unavailable.");
    const missing = errorPage(404);
    expect(missing).toContain("<title>404 Not Found</title>");
    expect(visibleText(missing)).toBe("error: 404 Not Found The page you requested is unavailable.");
  });

  it("words a banned address differently from a blocked path", () => {
    expect(visibleText(errorPage(403, { banned: true }))).toBe("error: 403 Forbidden Access from your address is unavailable right now.");
  });

  it("uses no color but black, white and gray", () => {
    const css = errorPage(403).match(/<style>([\s\S]*?)<\/style>/)![1];
    const colors = [...css.matchAll(/#([0-9a-f]{3,6})\b/gi)].map((m) => m[1].toLowerCase());
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) {
      const rgb = c.length === 3 ? [...c].map((x) => x + x) : (c.match(/../g) ?? []);
      expect(new Set(rgb).size, `#${c}`).toBe(1);
    }
    expect(css).not.toMatch(/oklch|hsl|rgb\(/i);
  });

  it("never names the app, its stack or Vardo", () => {
    for (const html of [errorPage(403), errorPage(404), errorPage(429), errorPage(403, { banned: true })]) {
      expect(visibleText(html)).not.toMatch(REVEALING);
    }
  });

  it("loads nothing and runs nothing, so its CSP stays closed", () => {
    const html = errorPage(403);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|@font-face|url\(|https?:\/\//i);
    const csp = HTML_RESPONSE_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/font-src|img-src|script-src|connect-src/);
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
