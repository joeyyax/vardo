// Bodies for turned-away requests. Generic on purpose: nothing about the app, its stack or why.

import { isBanRef, displayRef } from "./ban-ref";
import { isPermanent } from "./permanent";

const STATUS_NAME: Record<number, string> = { 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };

const UNAVAILABLE: Record<number, string> = {
  403: "This item is unavailable.",
  404: "The page you requested is unavailable.",
  429: "Too many requests. Try again later.",
};
const UNAVAILABLE_BANNED = "Access from your address is unavailable right now.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "05:24 UTC", with the date when it isn't today in UTC. */
function utcClock(at: Date, now: Date): string {
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  const sameDay = at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? time : `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${time}`;
}

/** The banned line: when the ban ends if it's known and still ahead, otherwise the generic wording. Says nothing about why. */
export function bannedMessage(until?: Date, now: Date = new Date()): string {
  if (!until || !(until.getTime() > now.getTime())) return UNAVAILABLE_BANNED;
  if (isPermanent(until)) return "Access from your address is unavailable, and there is no end date.";
  return `Access from your address is unavailable until ${utcClock(until, now)}.`;
}

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

// Black and white only. The heading and message use the reader's sans font; only the "error: 403" label is monospace,
// with shade and weight standing in for syntax-highlight hues.
const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#0a0a0a;--muted:#5c5c5c;--key:#737373;--punct:#a3a3a3;--num:#525252}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#f2f2f2;--muted:#a3a3a3;--key:#8a8a8a;--punct:#5c5c5c;--num:#a8a8a8}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:clamp(1.5rem,6vw,4rem);background:var(--bg);color:var(--fg);font:1rem/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:28rem;padding-bottom:6vh}
.code{margin:0 0 1rem;font:.75rem/1 ui-monospace,"SF Mono","JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace}
.k{color:var(--key)}
.p{color:var(--punct)}
.n{color:var(--num);font-weight:600}
h1{margin:0 0 .75rem;font-size:clamp(1.75rem,5vw,2.25rem);line-height:1.1;font-weight:680;letter-spacing:-.025em}
.message{margin:0;color:var(--muted);text-wrap:pretty}
.v{user-select:all}
`.trim();

/** The reference to show, as "403-13-K7M2": only for a ban that is still running, in the shape banRef() makes. */
export function shownRef(status: number, opts: { banned?: boolean; until?: Date; ref?: string; now?: Date }): string | null {
  const live = !!opts.until && opts.until.getTime() > (opts.now ?? new Date()).getTime();
  return opts.banned && live && opts.ref && isBanRef(opts.ref) ? displayRef(status, opts.ref) : null;
}

/** A small standalone page for a turned-away browser request: the status, its official name and one line. */
export function errorPage(status: number, opts: { banned?: boolean; until?: Date; ref?: string; now?: Date } = {}): string {
  const name = STATUS_NAME[status] ?? "Forbidden";
  const message = opts.banned ? bannedMessage(opts.until, opts.now) : (UNAVAILABLE[status] ?? UNAVAILABLE[403]);
  const ref = shownRef(status, opts);
  const label = ref
    ? `<p class="code"><span class="k">error</span><span class="p">:</span> <span class="v"><span class="n">${status}</span><span class="p">-</span><span class="n">${opts.ref}</span></span></p>`
    : `<p class="code"><span class="k">error</span><span class="p">:</span> <span class="n">${status}</span></p>`;
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
${label}
<h1>${name}</h1>
<p class="message">${message}</p>
</main>
</body>
</html>
`;
}
