// Bodies for turned-away requests. Generic on purpose: nothing about the app, its stack or why.

const STATUS_NAME: Record<number, string> = { 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };

const UNAVAILABLE: Record<number, string> = {
  403: "This item is unavailable.",
  404: "The page you requested is unavailable.",
  429: "Too many requests. Try again later.",
};
const UNAVAILABLE_BANNED = "Access from your address is unavailable right now.";

export const RESPONSE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export const HTML_RESPONSE_HEADERS = {
  ...RESPONSE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;

/** Whether the client asked for a page: a browser, not a scanner or API client. */
export function wantsHtml(accept: string | null): boolean {
  return !!accept && /\btext\/html\b/i.test(accept);
}

/** The plain-text body for a turned-away request. */
export function responseBody(status: number): string {
  return `${STATUS_NAME[status] ?? "Forbidden"}\n`;
}

// The console's palette (app/brand.css): warm ground, brass trim, muted body text. System fonts, since the
// page can't load any.
const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:oklch(95.8% .005 85);--fg:oklch(18% .012 75);--muted:oklch(44% .013 78);--brass:oklch(48% .098 72)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(16% .008 75);--fg:oklch(93% .006 85);--muted:oklch(68% .012 80);--brass:oklch(74% .085 82)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:clamp(1.5rem,6vw,4rem);background:var(--bg);color:var(--fg);font:1rem/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:28rem;padding-bottom:6vh}
.code{display:flex;align-items:center;gap:.75rem;margin:0 0 1.25rem;font-size:.8125rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--brass);font-variant-numeric:tabular-nums}
.code:before{content:"";width:1.5rem;height:1px;background:currentColor}
h1{margin:0 0 .75rem;font-size:clamp(1.75rem,5vw,2.25rem);line-height:1.1;font-weight:680;letter-spacing:-.025em}
.message{margin:0;color:var(--muted);text-wrap:pretty}
`.trim();

/** A small standalone page for a turned-away browser request: the status, its official name and one line. */
export function errorPage(status: number, opts: { banned?: boolean } = {}): string {
  const name = STATUS_NAME[status] ?? "Forbidden";
  const message = opts.banned ? UNAVAILABLE_BANNED : (UNAVAILABLE[status] ?? UNAVAILABLE[403]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${status} ${name}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<p class="code">Error ${status}</p>
<h1>${name}</h1>
<p class="message">${message}</p>
</main>
</body>
</html>
`;
}
