import type { ReactNode } from "react";
import { Section } from "./section";

/* ------------------------------------------------------------------ */
/*  Icon components                                                    */
/* ------------------------------------------------------------------ */

function RocketIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function NetworkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="6" height="6" rx="1" />
      <rect x="16" y="2" width="6" height="6" rx="1" />
      <rect x="9" y="16" width="6" height="6" rx="1" />
      <path d="M5 8v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <line x1="12" y1="12" x2="12" y2="16" />
    </svg>
  );
}

function ShieldCheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <path d="M10 12h4" />
    </svg>
  );
}

function ActivityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function LayersIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Feature data                                                      */
/* ------------------------------------------------------------------ */

const features: {
  title: string;
  description: string;
  details: string[];
  icon: ReactNode;
}[] = [
  {
    title: "Push, build, live",
    description:
      "Deploy from a Git push, Docker image, or Compose file. Blue-green deployments with automatic rollback on failure.",
    details: [
      "5 deploy types: Compose, Dockerfile, image, static, Nixpacks",
      "Blue-green with health checks — zero-downtime by default",
      "Persistent volumes survive redeploys",
      "Resource limits (CPU, memory) per app",
    ],
    icon: <RocketIcon className="h-6 w-6" />,
  },
  {
    title: "HTTPS on every app, automatically",
    description:
      "Add a domain, get a certificate. Wildcard DNS for instant subdomains. No Nginx configs, no cert wrangling.",
    details: [
      "Automatic certificate issuance and renewal",
      "Custom domains with DNS verification",
      "Wildcard subdomains out of the box",
      "Domain health monitoring with uptime tracking",
    ],
    icon: <NetworkIcon className="h-6 w-6" />,
  },
  {
    title: "Security isn't a feature you enable",
    description:
      "Passkey auth, encrypted secrets, rate limiting, CSP headers, org isolation. It's the layer everything else runs on.",
    details: [
      "Passkey/WebAuthn — phishing-resistant by default",
      "Secrets encrypted at rest with AES-256-GCM",
      "Per-token rate limiting backed by Redis",
      "Org isolation — no cross-org data access",
    ],
    icon: <ShieldCheckIcon className="h-6 w-6" />,
  },
  {
    title: "Automated, offsite, restorable",
    description:
      "Apps with persistent volumes get daily snapshots. Offsite storage, tiered retention, one-click restore.",
    details: [
      "Daily snapshots to S3-compatible storage",
      "Tiered retention: daily, weekly, monthly",
      "One-click restore from any snapshot",
      "Per-volume strategy: tar for files, pg_dump for databases",
    ],
    icon: <ArchiveIcon className="h-6 w-6" />,
  },
  {
    title: "Know before your users do",
    description:
      "Container metrics, log aggregation, system health dashboard. No external monitoring stack required.",
    details: [
      "CPU, memory, disk, network per container",
      "Centralized log aggregation across all apps",
      "Domain health monitoring with state transitions",
      "Email and webhook alerts on failures",
    ],
    icon: <ActivityIcon className="h-6 w-6" />,
  },
  {
    title: "Dev, staging, production — built in",
    description:
      "Environment-specific variables, domains, and configs. Promote between environments with one click.",
    details: [
      "Production, staging, dev, or custom environments",
      "Environment-specific variables and domains",
      "One-click promotion between environments",
      "Project-level grouping and shared config",
    ],
    icon: <LayersIcon className="h-6 w-6" />,
  },
  {
    title: "Export everything, move anywhere",
    description:
      "vardo.yml for settings, vardo.secrets.yml for keys. Export from one instance, import on another.",
    details: [
      "Config-as-code: vardo.yml (safe to commit)",
      "Secrets file with restricted permissions",
      "Full instance export/import",
      "Resolution chain: config file, DB, defaults",
    ],
    icon: <SettingsIcon className="h-6 w-6" />,
  },
  {
    title: "Dashboard, terminal, or AI agent",
    description:
      "Web UI, CLI, REST API, and MCP server. What you can do in the dashboard, you can do from a terminal or a script.",
    details: [
      "Dashboard: manage everything from a browser",
      "CLI: deploy, rollback, logs from the terminal",
      "REST API: every operation is an API call",
      "AI agents: MCP server for Claude, Cursor, and more",
    ],
    icon: <CodeIcon className="h-6 w-6" />,
  },
];

/* ------------------------------------------------------------------ */
/*  Feature card component                                             */
/* ------------------------------------------------------------------ */

function FeatureCard({ feature }: { feature: (typeof features)[number] }) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-7 transition-colors duration-200 hover:border-neutral-700">
      <div className="mb-4 text-neutral-400">{feature.icon}</div>
      <h3 className="text-lg font-bold text-white">{feature.title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-neutral-400">
        {feature.description}
      </p>
      <ul className="mt-5 space-y-2">
        {feature.details.map((detail) => (
          <li
            key={detail}
            className="flex items-start gap-2 text-sm text-neutral-500"
          >
            <span className="mt-1.5 block h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
            {detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Features section                                                  */
/* ------------------------------------------------------------------ */

export function Features() {
  return (
    <Section>
      <div className="mb-16 text-center">
        <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl lg:text-5xl">
          Everything you need to run production apps
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-neutral-400">
          Built on proven, battle-tested technology. No proprietary formats,
          no novel protocols, no reinvented wheels.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {features.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>
    </Section>
  );
}
