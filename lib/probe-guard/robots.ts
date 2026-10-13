// robots.txt and security.txt bodies. Trap paths go in as Disallow lines no polite crawler follows.

import type { InstanceProbeGuard } from "./settings";

export type RobotsGroup = { allow?: string[]; disallow?: string[] };

export function renderRobots(group: RobotsGroup, settings: Pick<InstanceProbeGuard, "traps">): string {
  const traps = settings.traps.enabled ? settings.traps.paths : [];
  const disallow = [...new Set([...(group.disallow ?? []), ...traps])];
  const lines = [
    "User-agent: *",
    ...(group.allow ?? []).map((p) => `Allow: ${p}`),
    ...disallow.map((p) => `Disallow: ${p}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** robots.txt for an app that opted in: everything open but the traps. */
export function renderAppRobots(settings: Pick<InstanceProbeGuard, "traps">): string {
  return renderRobots({ allow: ["/"] }, settings);
}

/** robots.txt for the console: sign-in and invites open, everything else closed. */
export function renderConsoleRobots(settings: Pick<InstanceProbeGuard, "traps">): string {
  return renderRobots({ allow: ["/login", "/invite/"], disallow: ["/"] }, settings);
}

/** RFC 9116 security.txt, or null without a contact. Expires a year out, renewed on every request. */
export function renderSecurityTxt(contact: string, opts: { canonical?: string; now?: Date } = {}): string | null {
  if (!contact) return null;
  const now = opts.now ?? new Date();
  const expires = new Date(now.getTime() + 365 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  const lines = [
    `Contact: mailto:${contact}`,
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    "Preferred-Languages: en",
    ...(opts.canonical ? [`Canonical: ${opts.canonical}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}
