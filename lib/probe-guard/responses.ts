// Bodies for turned-away probes. Short, friendly and free of anything about the app, its stack or Vardo.

import type { ProbeCategory } from "./rules";

export type ResponseKind = ProbeCategory | "trap" | "canary" | "banned";

const LINES: Record<ResponseKind, readonly string[]> = {
  secrets: [
    "Nice try. The .env is in another castle.",
    "No secrets here. Only this sentence.",
    "The keys are under the doormat. Just not this doormat.",
  ],
  vcs: [
    "Nothing to check out here.",
    "This repository has no history with you.",
    "git log: no commits by you, ever.",
  ],
  wordpress: [
    "This is not the WordPress you're looking for.",
    "No WordPress here. Not even a little bit.",
    "wp-admin has left the building.",
  ],
  "db-admin": [
    "418: I'm a teapot, not a phpMyAdmin.",
    "The database admin is out to lunch. Indefinitely.",
  ],
  cgi: [
    "The cgi-bin was recycled years ago.",
    "This bin is empty.",
  ],
  framework: [
    "No debug console here. Just this one line.",
    "Nothing to execute but this sentence.",
  ],
  "server-info": [
    "Status: politely declining.",
    "Server status: minding its own business.",
  ],
  backup: [
    "The backup of the backup is also not here.",
    "Fresh out of config files.",
  ],
  traversal: [
    "../../../nope",
    "You can climb the directory tree all day. It ends here.",
  ],
  router: [
    "Wrong number. This isn't a router.",
    "No modem here. Just a polite refusal.",
  ],
  trap: [
    "Nothing here but dust bunnies.",
    "This room is empty. It always was.",
  ],
  canary: [
    "Those credentials are as fake as they look.",
    "That key opens nothing.",
  ],
  banned: [
    "Taking a short break from you. Try again later.",
    "This door is closed for now.",
  ],
};

/** Lines for the console's own 404, revealed when the ghost is clicked. */
export const NOT_FOUND_LINES = [
  "there's nothing here",
  "this page went out haunting",
  "not even a ghost of a page",
  "boo. also, 404.",
] as const;
export const PLAIN_NOT_FOUND = "there's nothing here";

export function notFoundLine(humor: boolean, pick: () => number = Math.random): string {
  if (!humor) return PLAIN_NOT_FOUND;
  return NOT_FOUND_LINES[Math.min(NOT_FOUND_LINES.length - 1, Math.floor(pick() * NOT_FOUND_LINES.length))];
}

const PLAIN: Record<number, string> = { 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };

// What a person sees when humor is off. Generic on purpose: nothing about the app, its stack or why.
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

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Every line, for tests and review. */
export function allLines(): string[] {
  return Object.values(LINES).flat();
}

/** The body for a turned-away request. `pick` returns 0 to 1, Math.random by default. */
export function responseBody(kind: ResponseKind, status: number, humor: boolean, pick: () => number = Math.random): string {
  if (!humor) return `${PLAIN[status] ?? "Forbidden"}\n`;
  const lines = LINES[kind];
  return `${lines[Math.min(lines.length - 1, Math.floor(pick() * lines.length))]}\n`;
}

/** A small standalone page for a turned-away browser request: the status, its official name and one line. */
export function errorPage(kind: ResponseKind, status: number, humor: boolean, pick: () => number = Math.random): string {
  const title = PLAIN[status] ?? "Forbidden";
  const message = humor
    ? responseBody(kind, status, true, pick).trimEnd()
    : kind === "banned"
      ? UNAVAILABLE_BANNED
      : (UNAVAILABLE[status] ?? UNAVAILABLE[403]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${status} ${title}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}
main{padding:2rem;max-width:28rem;text-align:center}
h1{margin:0;font-size:4rem;font-weight:300;letter-spacing:-.02em;opacity:.35}
h2{margin:.25rem 0 1rem;font-size:1.25rem;font-weight:600}
p{margin:0;opacity:.7}
</style>
</head>
<body>
<main>
<h1>${status}</h1>
<h2>${title}</h2>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}
