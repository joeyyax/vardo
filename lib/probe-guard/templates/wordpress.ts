import type { ProbeTemplate } from "./types";

// Signals and entries are drafts: check them against real installs before raising the version.
export const wordpress: ProbeTemplate = {
  id: "wordpress",
  name: "WordPress",
  description: "For apps that run WordPress. Turns away files WordPress sites commonly leak. Login, admin and XML-RPC stay open unless you turn their rules on.",
  version: 1,
  detect: [
    { image: /(?:^|\/)wordpress(?:[:@]|$)/i },
    { path: "/wp-login.php", body: /name=["']log["']/i },
    { path: "/", body: /<meta name=["']generator["'] content=["']WordPress/i },
  ],
  turnAway: [
    { kind: "regex", value: String.raw`^(?:/(?:wordpress|wp|blog))?/wp-content/debug\.log`, note: "WordPress debug log" },
    { kind: "regex", value: String.raw`^(?:/(?:wordpress|wp|blog))?/(?:readme\.html|license\.txt)$`, note: "Reveals the WordPress version" },
  ],
};
