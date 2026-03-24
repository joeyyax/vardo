import type { ReactNode } from "react";
import { Section } from "./section";

/* ------------------------------------------------------------------ */
/*  Inline SVG tech logos — no external deps                          */
/* ------------------------------------------------------------------ */

function GitLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.546 10.93L13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.66 2.66a1.838 1.838 0 1 1-1.103 1.03l-2.48-2.48v6.53a1.838 1.838 0 1 1-1.512-.09V8.75a1.838 1.838 0 0 1-.998-2.41L7.629 3.607.452 10.784a1.55 1.55 0 0 0 0 2.188l10.48 10.48a1.55 1.55 0 0 0 2.186 0l10.428-10.428a1.55 1.55 0 0 0 0-2.093z" />
    </svg>
  );
}

function DockerLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.954 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.916 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.955 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm5.87-2.812h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.954 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.955 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm2.955-2.812h2.118a.186.186 0 0 0 .187-.186V3.38a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.186.187.186zm8.824 2.812h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zM24 11.8c-.442-.478-1.497-.648-2.301-.51-.104-.765-.57-1.43-1.117-1.985l-.383-.372-.378.387c-.453.462-.676 1.09-.62 1.71.026.297.116.585.265.838.191.31.465.575.788.765-.324.187-.691.327-1.01.395a6.4 6.4 0 0 1-1.838.194H.112l-.037.524c-.108 1.59.225 3.184.97 4.569C1.92 19.654 3.292 20.752 5 21.385c1.925.712 4.05.87 6.095.636 1.604-.183 3.146-.685 4.53-1.485 1.15-.664 2.172-1.543 3.02-2.601.707-.886 1.343-1.883 1.85-2.975h.16c.994 0 1.607-.397 1.945-.734.222-.214.394-.472.5-.755l.07-.205-.17-.117z" />
    </svg>
  );
}

function TraefikLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-.5 4.5h1v3h-1v-3zm-4 4h9v1.5h-9V8.5zm1.5 3h6v1.5h-6v-1.5zm-3 3h12v1.5H6v-1.5zm1.5 3h9v1.5h-9v-1.5z" />
    </svg>
  );
}

function LockShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7l-9-5z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 7.5a5 5 0 1 1-3.5 8.5H8v-3H5v-3H2l1-2h4l3 2h2.1" />
      <circle cx="16" cy="8" r="1.5" />
    </svg>
  );
}

function RedisLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M10.5 1.5L12 4.5l1.5-3 3 1.5-1.5 3 3 1.5-3 1.5 1.5 3-3-1.5-1.5 3-1.5-3-3 1.5 1.5-3-3-1.5 3-1.5-1.5-3z" />
      <path d="M12 14c5.523 0 10 1.79 10 4v2c0 2.21-4.477 4-10 4S2 22.21 2 20v-2c0-2.21 4.477-4 10-4z" opacity="0.6" />
    </svg>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}

function FileCodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="11" y2="15" />
      <line x1="9" y1="17" x2="11" y2="15" />
      <line x1="13" y1="13" x2="15" y2="15" />
      <line x1="13" y1="17" x2="15" y2="15" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function BranchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

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
/*  Tech pill component                                               */
/* ------------------------------------------------------------------ */

interface TechPill {
  name: string;
  icon?: ReactNode;
}

function TechPillBadge({ pill }: { pill: TechPill }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200/60 dark:border-neutral-800/60 bg-neutral-100/50 dark:bg-neutral-800/50 px-2.5 py-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400 transition-colors group-hover:border-neutral-200 dark:group-hover:border-neutral-800 group-hover:bg-neutral-100 dark:group-hover:bg-neutral-800">
      {pill.icon && <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">{pill.icon}</span>}
      {pill.name}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Feature card accent colors — one tint per category                */
/* ------------------------------------------------------------------ */

const accentColors = [
  { border: "border-l-blue-500 dark:border-l-blue-400", iconBg: "bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400", glow: "bg-blue-400/10" },
  { border: "border-l-emerald-500 dark:border-l-emerald-400", iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400", glow: "bg-emerald-400/10" },
  { border: "border-l-amber-500 dark:border-l-amber-400", iconBg: "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400", glow: "bg-amber-400/10" },
  { border: "border-l-violet-500 dark:border-l-violet-400", iconBg: "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400", glow: "bg-violet-400/10" },
  { border: "border-l-rose-500 dark:border-l-rose-400", iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400", glow: "bg-rose-400/10" },
  { border: "border-l-cyan-500 dark:border-l-cyan-400", iconBg: "bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-400", glow: "bg-cyan-400/10" },
  { border: "border-l-orange-500 dark:border-l-orange-400", iconBg: "bg-orange-100 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400", glow: "bg-orange-400/10" },
  { border: "border-l-indigo-500 dark:border-l-indigo-400", iconBg: "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400", glow: "bg-indigo-400/10" },
];

/* ------------------------------------------------------------------ */
/*  Feature data                                                      */
/* ------------------------------------------------------------------ */

const features: {
  category: string;
  title: string;
  description: string;
  details: string[];
  icon: ReactNode;
  techPills: TechPill[];
}[] = [
  {
    category: "Deployments",
    title: "Push, build, live",
    description:
      "Deploy from a Git push, Docker image, or Compose file. Blue-green deployments with automatic rollback on failure. One-click rollback to any previous version.",
    details: [
      "5 deploy types: Compose, Dockerfile, image, static, Nixpacks",
      "Blue-green with health checks — zero-downtime by default",
      "Persistent volumes survive redeploys",
      "Resource limits (CPU, memory) per app",
    ],
    icon: <RocketIcon className="h-7 w-7" />,
    techPills: [
      { name: "Git", icon: <GitLogo className="h-3 w-3" /> },
      { name: "Docker", icon: <DockerLogo className="h-3 w-3" /> },
      { name: "Compose", icon: <DockerLogo className="h-3 w-3" /> },
    ],
  },
  {
    category: "Networking & TLS",
    title: "HTTPS on every app, automatically",
    description:
      "Add a domain, get a certificate. Wildcard DNS for instant subdomains. HTTP→HTTPS redirect by default. No Nginx configs, no cert wrangling.",
    details: [
      "Automatic certificate issuance and renewal",
      "Custom domains with DNS verification",
      "Wildcard subdomains out of the box",
      "Domain health monitoring with uptime tracking",
    ],
    icon: <NetworkIcon className="h-7 w-7" />,
    techPills: [
      { name: "Traefik", icon: <TraefikLogo className="h-3 w-3" /> },
      { name: "Let's Encrypt", icon: <LockShieldIcon className="h-3 w-3" /> },
    ],
  },
  {
    category: "Security",
    title: "Security isn't a feature you enable",
    description:
      "Passkey auth, encrypted secrets, rate limiting, CSP headers, org isolation. It's the layer everything else runs on.",
    details: [
      "Passkey/WebAuthn — phishing-resistant by default",
      "Secrets encrypted at rest with AES-256-GCM",
      "Per-token rate limiting backed by Redis",
      "Org isolation — no cross-org data access",
    ],
    icon: <ShieldCheckIcon className="h-7 w-7" />,
    techPills: [
      { name: "WebAuthn", icon: <KeyIcon className="h-3 w-3" /> },
      { name: "AES-256", icon: <LockShieldIcon className="h-3 w-3" /> },
      { name: "Redis", icon: <RedisLogo className="h-3 w-3" /> },
    ],
  },
  {
    category: "Backups",
    title: "Automated, offsite, restorable",
    description:
      "Apps with persistent volumes get daily snapshots. Offsite storage, tiered retention, one-click restore. No downtime, no container restarts.",
    details: [
      "Daily snapshots to S3-compatible storage",
      "Tiered retention: daily, weekly, monthly",
      "One-click restore from any snapshot",
      "Per-volume strategy: tar for files, pg_dump for databases",
    ],
    icon: <ArchiveIcon className="h-7 w-7" />,
    techPills: [
      { name: "S3", icon: <CloudIcon className="h-3 w-3" /> },
      { name: "R2", icon: <CloudIcon className="h-3 w-3" /> },
      { name: "B2", icon: <CloudIcon className="h-3 w-3" /> },
    ],
  },
  {
    category: "Monitoring",
    title: "Know before your users do",
    description:
      "Container metrics, log aggregation, system health dashboard. No external monitoring stack required.",
    details: [
      "CPU, memory, disk, network per container",
      "Centralized log aggregation across all apps",
      "Domain health monitoring with state transitions",
      "Email and webhook alerts on failures",
    ],
    icon: <ActivityIcon className="h-7 w-7" />,
    techPills: [
      { name: "cAdvisor", icon: <ChartIcon className="h-3 w-3" /> },
      { name: "Loki", icon: <ChartIcon className="h-3 w-3" /> },
    ],
  },
  {
    category: "Environments",
    title: "Dev, staging, production — built in",
    description:
      "Environment-specific variables, domains, and configs. Promote between environments with one click. Projects group related apps.",
    details: [
      "Production, staging, dev, or custom environments",
      "Environment-specific variables and domains",
      "One-click promotion between environments",
      "Project-level grouping and shared config",
    ],
    icon: <LayersIcon className="h-7 w-7" />,
    techPills: [
      { name: "Git branches", icon: <BranchIcon className="h-3 w-3" /> },
      { name: "Compose", icon: <DockerLogo className="h-3 w-3" /> },
    ],
  },
  {
    category: "Configuration",
    title: "Export everything, move anywhere",
    description:
      "vardo.yml for settings, vardo.secrets.yml for keys. Export from one instance, import on another. No proprietary formats.",
    details: [
      "Config-as-code: vardo.yml (safe to commit)",
      "Secrets file with restricted permissions",
      "Full instance export/import",
      "Resolution chain: config file → DB → defaults",
    ],
    icon: <SettingsIcon className="h-7 w-7" />,
    techPills: [
      { name: "YAML", icon: <FileCodeIcon className="h-3 w-3" /> },
      { name: "Portable", icon: <FileCodeIcon className="h-3 w-3" /> },
    ],
  },
  {
    category: "Developer experience",
    title: "Dashboard, terminal, or AI agent",
    description:
      "Web UI, CLI, REST API, and MCP server. What you can do in the dashboard, you can do from a terminal or a script.",
    details: [
      "Dashboard: manage everything from a browser",
      "CLI: deploy, rollback, logs from the terminal",
      "REST API: every operation is an API call",
      "AI agents: MCP server for Claude, Cursor, and more",
    ],
    icon: <CodeIcon className="h-7 w-7" />,
    techPills: [
      { name: "REST", icon: <TerminalIcon className="h-3 w-3" /> },
      { name: "CLI", icon: <TerminalIcon className="h-3 w-3" /> },
      { name: "MCP", icon: <TerminalIcon className="h-3 w-3" /> },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Feature card component                                             */
/* ------------------------------------------------------------------ */

function FeatureCard({
  feature,
  accent,
  hero = false,
}: {
  feature: (typeof features)[number];
  accent: (typeof accentColors)[number];
  hero?: boolean;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 transition-all duration-300 hover:shadow-lg dark:hover:shadow-blue-600/5 ${
        hero
          ? `border-l-4 ${accent.border} p-8 sm:p-10`
          : `border-l-[3px] ${accent.border} p-7`
      }`}
    >
      {/* Accent glow */}
      <div
        className={`pointer-events-none absolute -right-10 -top-10 rounded-full blur-3xl ${accent.glow} ${
          hero ? "h-48 w-48" : "h-32 w-32 opacity-60"
        }`}
      />

      <div className={hero ? "relative grid gap-8 sm:grid-cols-[1fr_auto]" : "relative"}>
        <div>
          {/* Category icon + label */}
          <div className="mb-4 flex items-center gap-3">
            <div className={`inline-flex rounded-xl p-2.5 ${accent.iconBg}`}>
              {feature.icon}
            </div>
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              {feature.category}
            </span>
          </div>

          {/* Title & description */}
          <h3
            className={`font-bold text-neutral-900 dark:text-neutral-100 ${
              hero ? "text-2xl sm:text-3xl" : "text-lg"
            }`}
          >
            {feature.title}
          </h3>
          <p
            className={`mt-3 leading-relaxed text-neutral-500 dark:text-neutral-400 ${
              hero ? "max-w-lg text-base" : "text-sm"
            }`}
          >
            {feature.description}
          </p>

          {/* Detail list */}
          <ul className={`mt-5 space-y-2 ${hero ? "columns-1 sm:columns-2 gap-x-8" : ""}`}>
            {feature.details.map((detail) => (
              <li
                key={detail}
                className="flex items-start gap-2 text-sm text-neutral-500 dark:text-neutral-400 break-inside-avoid"
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
                  className="mt-0.5 shrink-0 text-blue-500/70 dark:text-blue-400/70"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {detail}
              </li>
            ))}
          </ul>
        </div>

        {/* Tech pills — sidebar on hero, bottom on regular */}
        <div
          className={
            hero
              ? "flex flex-row flex-wrap gap-1.5 sm:flex-col sm:justify-start sm:pt-14"
              : "mt-5 flex flex-wrap gap-1.5"
          }
        >
          {feature.techPills.map((pill) => (
            <TechPillBadge key={pill.name} pill={pill} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Features section                                                  */
/* ------------------------------------------------------------------ */

export function Features() {
  // First two features are "hero" features (full width)
  const heroFeatures = features.slice(0, 2);
  // Rest are in a tighter grid
  const gridFeatures = features.slice(2);

  return (
    <Section>
      <div className="mb-16 text-center">
        <h2 className="text-3xl font-extrabold tracking-tight text-neutral-900 dark:text-neutral-100 sm:text-4xl lg:text-5xl">
          Everything you need to run production apps
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-neutral-500 dark:text-neutral-400">
          Built on proven, battle-tested technology. No proprietary formats,
          no novel protocols, no reinvented wheels.
        </p>
      </div>

      {/* Hero features — full width, more prominent */}
      <div className="grid gap-5 sm:grid-cols-2">
        {heroFeatures.map((feature, i) => (
          <FeatureCard
            key={feature.category}
            feature={feature}
            accent={accentColors[i]}
            hero
          />
        ))}
      </div>

      {/* Grid features — tighter, 3 columns */}
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {gridFeatures.map((feature, i) => (
          <FeatureCard
            key={feature.category}
            feature={feature}
            accent={accentColors[i + 2]}
          />
        ))}
      </div>
    </Section>
  );
}
