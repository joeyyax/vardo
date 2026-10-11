// robots.txt and security.txt bodies. Trap paths go in as Disallow lines no polite crawler follows.

import type { InstanceProbeGuard } from "./settings";

const ROBOTS_GREETING = "# Hello, robot. Mind the gaps and have a nice crawl.";

export type RobotsGroup = { allow?: string[]; disallow?: string[] };

export function renderRobots(group: RobotsGroup, settings: Pick<InstanceProbeGuard, "humor" | "traps">): string {
  const traps = settings.traps.enabled ? settings.traps.paths : [];
  const disallow = [...new Set([...(group.disallow ?? []), ...traps])];
  const lines = [
    ...(settings.humor ? [ROBOTS_GREETING] : []),
    "User-agent: *",
    ...(group.allow ?? []).map((p) => `Allow: ${p}`),
    ...disallow.map((p) => `Disallow: ${p}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** robots.txt for an app that opted in: everything open but the traps. */
export function renderAppRobots(settings: Pick<InstanceProbeGuard, "humor" | "traps">): string {
  return renderRobots({ allow: ["/"] }, settings);
}

/** robots.txt for the console: sign-in and invites open, everything else closed. */
export function renderConsoleRobots(settings: Pick<InstanceProbeGuard, "humor" | "traps">): string {
  return renderRobots({ allow: ["/login", "/invite/"], disallow: ["/"] }, settings);
}

/** RFC 9116 security.txt, or null without a contact. Expires a year out, renewed on every request. */
export function renderSecurityTxt(contact: string, opts: { humor: boolean; canonical?: string; now?: Date }): string | null {
  if (!contact) return null;
  const now = opts.now ?? new Date();
  const expires = new Date(now.getTime() + 365 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  const lines = [
    ...(opts.humor ? ["# Found something? Thank you for looking out for us. Please write before you write it up."] : []),
    `Contact: mailto:${contact}`,
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    "Preferred-Languages: en",
    ...(opts.canonical ? [`Canonical: ${opts.canonical}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}
