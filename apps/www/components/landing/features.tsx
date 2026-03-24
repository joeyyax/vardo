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
/*  Tech icons — only for recognizable logos                           */
/* ------------------------------------------------------------------ */

/* Simple Icons brand SVGs — from simpleicons.org */
const techIcons: Record<string, ReactNode> = {
  Git: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.546 10.93L13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.66 2.66a1.838 1.838 0 1 1-1.103 1.03l-2.48-2.48v6.53a1.838 1.838 0 1 1-1.512-.09V8.75a1.838 1.838 0 0 1-.998-2.41L7.629 3.607.452 10.784a1.55 1.55 0 0 0 0 2.188l10.48 10.48a1.55 1.55 0 0 0 2.186 0l10.428-10.428a1.55 1.55 0 0 0 0-2.093z" />
    </svg>
  ),
  Docker: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.954 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.916 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.955 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm5.87-2.812h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.954 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.955 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm2.955-2.812h2.118a.186.186 0 0 0 .187-.186V3.38a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.186.187.186zm-5.87 5.625h2.118a.186.186 0 0 0 .187-.186v-1.886a.186.186 0 0 0-.187-.186H2.204a.186.186 0 0 0-.187.186v1.886c0 .103.084.186.187.186zM24 11.8c-.442-.478-1.497-.648-2.301-.51-.104-.765-.57-1.43-1.117-1.985l-.383-.372-.378.387c-.453.462-.676 1.09-.62 1.71.026.297.116.585.265.838.191.31.465.575.788.765-.324.187-.691.327-1.01.395a6.4 6.4 0 0 1-1.838.194H.112l-.037.524c-.108 1.59.225 3.184.97 4.569C1.92 19.654 3.292 20.752 5 21.385c1.925.712 4.05.87 6.095.636 1.604-.183 3.146-.685 4.53-1.485 1.15-.664 2.172-1.543 3.02-2.601.707-.886 1.343-1.883 1.85-2.975h.16c.994 0 1.607-.397 1.945-.734.222-.214.394-.472.5-.755l.07-.205-.17-.117z" />
    </svg>
  ),
  Compose: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.954 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.916 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm-2.955 0h2.118a.186.186 0 0 0 .187-.185V9.006a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186v1.887c0 .103.084.185.187.185zm5.87-2.812h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.954 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm-2.955 0h2.118a.186.186 0 0 0 .187-.186V6.193a.186.186 0 0 0-.187-.186H5.158a.186.186 0 0 0-.187.186V8.08c0 .103.084.186.187.186zm2.955-2.812h2.118a.186.186 0 0 0 .187-.186V3.38a.186.186 0 0 0-.187-.186H8.113a.186.186 0 0 0-.187.186v1.887c0 .103.084.186.187.186zm-5.87 5.625h2.118a.186.186 0 0 0 .187-.186v-1.886a.186.186 0 0 0-.187-.186H2.204a.186.186 0 0 0-.187.186v1.886c0 .103.084.186.187.186zM24 11.8c-.442-.478-1.497-.648-2.301-.51-.104-.765-.57-1.43-1.117-1.985l-.383-.372-.378.387c-.453.462-.676 1.09-.62 1.71.026.297.116.585.265.838.191.31.465.575.788.765-.324.187-.691.327-1.01.395a6.4 6.4 0 0 1-1.838.194H.112l-.037.524c-.108 1.59.225 3.184.97 4.569C1.92 19.654 3.292 20.752 5 21.385c1.925.712 4.05.87 6.095.636 1.604-.183 3.146-.685 4.53-1.485 1.15-.664 2.172-1.543 3.02-2.601.707-.886 1.343-1.883 1.85-2.975h.16c.994 0 1.607-.397 1.945-.734.222-.214.394-.472.5-.755l.07-.205-.17-.117z" />
    </svg>
  ),
  Redis: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.5 2.661l.54.997-1.797.644 2.409.166.538.985.96-1.166 2.585.09-1.226-.674 1.045-1.215-2.164.476L12.066.804l-.524 1.857-1.042-.534v.534zm8.604 3.753c-2.174-.99-6.723-1.054-10.049-.006-3.326 1.048-3.726 2.6-1.552 3.59 2.174.989 6.723 1.054 10.049.005 3.326-1.048 3.726-2.6 1.552-3.59zM12 22c6.627 0 12-2.686 12-6v-4c0 3.314-5.373 6-12 6S0 15.314 0 12v4c0 3.314 5.373 6 12 6zm0-4c6.627 0 12-2.686 12-6v-4c0 3.314-5.373 6-12 6S0 11.314 0 8v4c0 3.314 5.373 6 12 6z" />
    </svg>
  ),
  Traefik: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 17.07H6.106V15h11.788v2.07zm0-3.535H6.106v-2.07h11.788v2.07zm0-3.535H6.106V7.93h11.788V10z" />
    </svg>
  ),
  "Let's Encrypt": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 2.18l7 3.12v4.7c0 4.83-3.4 9.36-7 10.5-3.6-1.14-7-5.67-7-10.5V6.3l7-3.12zM10 12l-2-2-1.41 1.41L10 14.82l6.41-6.41L15 7l-5 5z" />
    </svg>
  ),
  WebAuthn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M12 10v12" />
      <path d="M18 16l-6-3-6 3" />
    </svg>
  ),
  "AES-256": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  S3: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103a6.395 6.395 0 0 0-.862.272 2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167 4.588 4.588 0 0 1 1.03-.375A5.017 5.017 0 0 1 5.8 4.7c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586l.01.14zM15.685 12c.103 0 .175.008.224.04.048.024.088.088.12.176l1.367 4.513c.047.152.087.336.12.56.063-.224.111-.408.167-.56l1.46-4.513a.298.298 0 0 1 .127-.176c.056-.032.128-.04.224-.04h.942c.103 0 .175.008.224.04.048.024.088.088.12.176l1.483 4.569c.04.12.08.296.12.519.031-.224.071-.4.119-.52l1.366-4.568a.29.29 0 0 1 .12-.176c.047-.032.127-.04.224-.04h.863c.128 0 .192.063.192.192 0 .039-.008.079-.016.127a1.084 1.084 0 0 1-.04.136l-1.869 5.946c-.04.136-.087.232-.135.288-.048.056-.136.08-.264.08h-.958c-.103 0-.175-.008-.223-.04-.048-.032-.088-.088-.12-.176l-1.458-4.397a5.03 5.03 0 0 1-.12-.52c-.031.2-.071.36-.12.52l-1.482 4.397a.298.298 0 0 1-.128.176c-.048.032-.127.04-.224.04h-.957c-.128 0-.216-.024-.264-.08a.675.675 0 0 1-.136-.288l-1.868-5.946a1.31 1.31 0 0 1-.04-.136.36.36 0 0 1-.016-.127c0-.128.063-.192.191-.192h.879z" />
    </svg>
  ),
  R2: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.505 9.01l-2.631-2.265c-.18-.165-.48-.18-.66-.015L6.93 12.735c-.18.165-.195.435-.045.615l2.28 2.955c.15.18.42.225.615.075l6.75-5.04 1.335 1.11a.375.375 0 0 0 .6-.3V9.45a.75.75 0 0 0-.27-.57l-1.69-1.455v1.585z" />
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0z" fillOpacity="0.15" />
      <path d="M16.505 9.01l-2.631-2.265c-.18-.165-.48-.18-.66-.015L6.93 12.735c-.18.165-.195.435-.045.615l2.28 2.955c.15.18.42.225.615.075l6.75-5.04 1.335 1.11a.375.375 0 0 0 .6-.3V9.45a.75.75 0 0 0-.27-.57l-1.69-1.455v1.585z" />
    </svg>
  ),
  B2: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0L1.5 6v12L12 24l10.5-6V6L12 0zm0 2.18l8.5 4.82v9.6L12 21.82l-8.5-4.82V7l8.5-4.82z" />
      <path d="M12 5.5L6 9v6l6 3.5L18 15V9l-6-3.5z" fillOpacity="0.3" />
    </svg>
  ),
  "Git branches": (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.546 10.93L13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.66 2.66a1.838 1.838 0 1 1-1.103 1.03l-2.48-2.48v6.53a1.838 1.838 0 1 1-1.512-.09V8.75a1.838 1.838 0 0 1-.998-2.41L7.629 3.607.452 10.784a1.55 1.55 0 0 0 0 2.188l10.48 10.48a1.55 1.55 0 0 0 2.186 0l10.428-10.428a1.55 1.55 0 0 0 0-2.093z" />
    </svg>
  ),
  cAdvisor: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12c2.54 0 4.894-.79 6.834-2.135l-3.107-3.107A7.467 7.467 0 0 1 12 19.5a7.5 7.5 0 1 1 7.5-7.5c0 1.38-.374 2.672-1.025 3.784l3.09 3.09A11.94 11.94 0 0 0 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  ),
  Loki: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/*  Feature data                                                      */
/* ------------------------------------------------------------------ */

const features: {
  title: string;
  description: string;
  details: string[];
  icon: ReactNode;
  tech: string[];
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
    tech: ["Git", "Docker", "Compose"],
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
    tech: ["Traefik", "Let's Encrypt"],
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
    tech: ["WebAuthn", "AES-256", "Redis"],
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
    tech: ["S3", "R2", "B2"],
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
    tech: ["cAdvisor", "Loki"],
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
    tech: ["Git branches", "Compose"],
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
    tech: ["YAML", "Portable"],
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
    tech: ["REST", "CLI", "MCP"],
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
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {feature.tech.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-neutral-500"
          >
            {techIcons[t] && (
              <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
                {techIcons[t]}
              </span>
            )}
            {t}
          </span>
        ))}
      </div>
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
