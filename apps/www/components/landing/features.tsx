import { Section } from "./section";

const features = [
  {
    category: "Deployments",
    builtOn: "Git · Docker · Compose",
    title: "Push, build, live",
    description:
      "Deploy from a Git push, Docker image, or Compose file. Blue-green deployments with automatic rollback on failure. One-click rollback to any previous version.",
    details: [
      "5 deploy types: Compose, Dockerfile, image, static, Nixpacks",
      "Blue-green with health checks — zero-downtime by default",
      "Persistent volumes survive redeploys",
      "Resource limits (CPU, memory) per app",
    ],
  },
  {
    category: "Networking & TLS",
    builtOn: "Traefik · Let's Encrypt",
    title: "HTTPS on every app, automatically",
    description:
      "Add a domain, get a certificate. Wildcard DNS for instant subdomains. HTTP→HTTPS redirect by default. No Nginx configs, no cert wrangling.",
    details: [
      "Automatic certificate issuance and renewal",
      "Custom domains with DNS verification",
      "Wildcard subdomains out of the box",
      "Domain health monitoring with uptime tracking",
    ],
  },
  {
    category: "Security",
    builtOn: "WebAuthn · AES-256-GCM · Redis",
    title: "Security isn't a feature you enable",
    description:
      "Passkey auth, encrypted secrets, rate limiting, CSP headers, org isolation. It's the layer everything else runs on.",
    details: [
      "Passkey/WebAuthn — phishing-resistant by default",
      "Secrets encrypted at rest with AES-256-GCM",
      "Per-token rate limiting backed by Redis",
      "Org isolation — no cross-org data access",
    ],
  },
  {
    category: "Backups",
    builtOn: "S3 · R2 · B2 · SSH",
    title: "Automated, offsite, restorable",
    description:
      "Apps with persistent volumes get daily snapshots. Offsite storage, tiered retention, one-click restore. No downtime, no container restarts.",
    details: [
      "Daily snapshots to S3-compatible storage",
      "Tiered retention: daily, weekly, monthly",
      "One-click restore from any snapshot",
      "Per-volume strategy: tar for files, pg_dump for databases",
    ],
  },
  {
    category: "Monitoring",
    builtOn: "cAdvisor · Loki",
    title: "Know before your users do",
    description:
      "Container metrics, log aggregation, system health dashboard. No external monitoring stack required.",
    details: [
      "CPU, memory, disk, network per container",
      "Centralized log aggregation across all apps",
      "Domain health monitoring with state transitions",
      "Email and webhook alerts on failures",
    ],
  },
  {
    category: "Environments",
    builtOn: "Git branches · Docker Compose",
    title: "Dev, staging, production — built in",
    description:
      "Environment-specific variables, domains, and configs. Promote between environments with one click. Projects group related apps.",
    details: [
      "Production, staging, dev, or custom environments",
      "Environment-specific variables and domains",
      "One-click promotion between environments",
      "Project-level grouping and shared config",
    ],
  },
  {
    category: "Configuration",
    builtOn: "YAML · portable formats",
    title: "Export everything, move anywhere",
    description:
      "vardo.yml for settings, vardo.secrets.yml for keys. Export from one instance, import on another. No proprietary formats.",
    details: [
      "Config-as-code: vardo.yml (safe to commit)",
      "Secrets file with restricted permissions",
      "Full instance export/import",
      "Resolution chain: config file → DB → defaults",
    ],
  },
  {
    category: "Developer experience",
    builtOn: "REST · CLI · MCP",
    title: "Dashboard, terminal, or AI agent",
    description:
      "Web UI, CLI, REST API, and MCP server. What you can do in the dashboard, you can do from a terminal or a script.",
    details: [
      "Dashboard: manage everything from a browser",
      "CLI: deploy, rollback, logs from the terminal",
      "REST API: every operation is an API call",
      "AI agents: MCP server for Claude, Cursor, and more",
    ],
  },
];

export function Features() {
  return (
    <Section>
      <div className="mb-16">
        <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Everything you need to run
          <br />
          production apps
        </h2>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
          Each feature is built on proven, battle-tested technology. No
          proprietary formats, no novel protocols, no reinvented wheels.
        </p>
      </div>
      <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
        {features.map((feature) => (
          <div
            key={feature.category}
            className="bg-card p-8 transition-colors duration-200 hover:bg-muted/50"
          >
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                {feature.category}
              </span>
              <span className="text-xs text-muted-foreground/60 font-mono">
                {feature.builtOn}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-foreground">
              {feature.title}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {feature.description}
            </p>
            <ul className="mt-4 space-y-1.5">
              {feature.details.map((detail) => (
                <li
                  key={detail}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-0.5 shrink-0 text-primary/70"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {detail}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
