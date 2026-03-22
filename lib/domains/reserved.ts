/**
 * Reserved subdomains that cannot be used as project slugs.
 * Admins can bypass this list.
 */
export const RESERVED_SLUGS = new Set([
  // Infrastructure
  "api",
  "app",
  "admin",
  "dashboard",
  "panel",
  "console",
  "status",
  "health",
  "healthz",
  "metrics",
  "monitor",
  "monitoring",

  // Mail
  "mail",
  "smtp",
  "imap",
  "pop",
  "email",
  "postmaster",
  "mailer",

  // Web
  "www",
  "web",
  "static",
  "assets",
  "cdn",
  "media",
  "images",
  "img",
  "files",

  // Auth
  "auth",
  "login",
  "logout",
  "signup",
  "register",
  "sso",
  "oauth",
  "account",
  "accounts",

  // DNS / networking
  "ns",
  "ns1",
  "ns2",
  "dns",
  "ftp",
  "sftp",
  "ssh",
  "vpn",
  "proxy",
  "gateway",
  "lb",
  "loadbalancer",

  // Services
  "git",
  "gitlab",
  "github",
  "ci",
  "cd",
  "deploy",
  "registry",
  "docker",
  "k8s",
  "kubernetes",

  // Docs / support
  "docs",
  "doc",
  "help",
  "support",
  "wiki",
  "blog",
  "forum",
  "community",

  // Internal
  "internal",
  "staging",
  "preview",
  "dev",
  "development",
  "test",
  "testing",
  "sandbox",
  "demo",
  "beta",
  "alpha",
  "canary",
  "prod",
  "production",
  "local",
  "localhost",

  // Brand protection
  "host",
  "hostapp",
  "root",
  "system",
  "server",
  "node",
  "cluster",
  "default",
  "null",
  "undefined",
  "true",
  "false",

  // Abuse prevention
  "abuse",
  "spam",
  "security",
  "phishing",
  "autoconfig",
  "autodiscover",
  "wpad",

  // Traefik / reverse proxy
  "traefik",
  "caddy",
  "nginx",
  "haproxy",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
