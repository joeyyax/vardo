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

const PLAIN: Record<number, string> = { 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };

export const RESPONSE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

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
