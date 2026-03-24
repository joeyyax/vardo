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
/*  Tech icon helpers                                                  */
/* ------------------------------------------------------------------ */

function GitIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" />
    </svg>
  );
}

function DockerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
    </svg>
  );
}

function RedisIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.09 8.224l1.792-.282.065-1.832-1.069 1.035-1.437-.166.649 1.245zM23.64 10.112c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z" />
    </svg>
  );
}

function CloudflareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 01-.1333-.0713.1944.1944 0 01-.021-.1553c.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013a.2067.2067 0 00.0147-.168c-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
    </svg>
  );
}

function BackblazeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M9.3108.0003c.6527 1.3502 1.5666 4.0812-1.3887 7.1738-1.8096 1.8796-3.078 3.8487-2.3496 6.0644.3642 1.1037 1.1864 2.5079 2.8867 2.7852.6107.1008 1.3425-.0006 1.7403-.1406 2.4538-.8544 2.098-3.4138 1.5546-5.0469-.07-.2129-.1915-.7333-.2363-.9238-.3726-1.6023.776-2.6562 1.129-3.8047.028-.0925.0534-.1819.0702-.2715.042-.21.067-.423.0781-.6387 0-1.8264-.9882-2.6303-1.7754-3.5996C10.1794.5643 9.3107.0003 9.3107.0003zm6.2754 6.0175s-.709.3366-1.2188.8829c-.4454.4818-.8635.8789-1.2949 1.8593-.028.14-.0518.2863-.0742.4375-.2325 1.6416 1.1473 3.1446.7187 5.1895-.112.535-.3554.7123-.7812 1.6367-.5098 1.1065-.383 2.588.3594 3.5293.6723.8488 1.879 1.2321 3.0527.9492 2.1065-.5042 3.0646-2.2822 2.8965-4.2851-.1317-1.58-.8154-2.7536-2.754-4.961-.9607-1.0925-1.6072-2.409-1.5624-3.4062.1373-1.2074.6582-1.832.6582-1.832zM4.8928 15.1936c-.0222.0145-.0439.0614-.0586.1602a.0469.0469 0 01-.0059.0195v.01c-.1148.5406-.1649 1.823.1153 2.9687.353 1.4427 1.4175 3.902 4.412 5.129 2.5184 1.0336 5.718.5411 7.8497-1.627.5294-.5435.408-.4897-.4883-.2012v-.002c-1.1121.3558-3.5182.5463-4.7676-1-1.5239-1.8852-.4302-3.3633-1.3574-3.1504-3.6164.8348-5.2667-1.4657-5.5469-2.1016-.0023-.002-.0857-.2487-.1523-.205z" />
    </svg>
  );
}

function LokiIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function TraefikIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1.19c1.088 0 2.056.768 2.056 1.714 0 .947-.921 1.715-2.056 1.715-.13 0-.3-.022-.509-.064a.685.685 0 0 0-.475.076l-7.37 4.195a.344.344 0 0 0 .001.597l7.99 4.49c.208.116.461.116.669 0l8.034-4.468a.343.343 0 0 0 .003-.598l-2.507-1.424a.683.683 0 0 0-.67-.003l-2.647 1.468a.234.234 0 0 0-.119.18l-.001.025c0 .946-.921 1.714-2.056 1.714s-2.056-.768-2.056-1.714c0-.947.921-1.715 2.056-1.715.042 0 .09.002.145.007l.087.008.096.013a.685.685 0 0 0 .425-.08l3.913-2.173c.3-.166.662-.171.965-.017l.04.023 5.465 3.104c.686.39.693 1.368.03 1.773l-.037.021-3.656 2.033a.343.343 0 0 0 .007.604l3.62 1.906c.72.378.736 1.402.03 1.804l-10.995 6.272a1.03 1.03 0 0 1-1.019 0L.526 16.43a1.03 1.03 0 0 1 .034-1.806l3.66-1.911a.343.343 0 0 0 .01-.603L.524 10.029a1.03 1.03 0 0 1-.041-1.77l.036-.021L9.618 3.06a.688.688 0 0 0 .308-.369l.011-.036c.32-.952 1.046-1.466 2.063-1.466Zm5.076 12.63-4.492 2.586-.041.022c-.306.158-.671.152-.973-.018l-4.478-2.527a.682.682 0 0 0-.65-.01L3.86 15.224a.343.343 0 0 0-.012.602l7.887 4.515c.21.12.467.121.677 0l7.956-4.547a.343.343 0 0 0-.01-.602l-2.623-1.384a.683.683 0 0 0-.659.012z" />
    </svg>
  );
}

function LetsEncryptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.9914 0a.8829.8829 0 00-.8718.817v3.0209A.8829.8829 0 0012 4.7207a.8829.8829 0 00.8803-.8803V.817a.8829.8829 0 00-.889-.817zm7.7048 3.1089a.8804.8804 0 00-.5214.1742l-2.374 1.9482a.8804.8804 0 00.5592 1.5622.8794.8794 0 00.5592-.2001l2.3714-1.9506a.8804.8804 0 00-.5944-1.534zm-15.3763.0133a.8829.8829 0 00-.611 1.5206l2.37 1.9506a.876.876 0 00.5606.2001v-.002a.8804.8804 0 00.5597-1.5602L4.8277 3.2831a.8829.8829 0 00-.5078-.161zm7.6598 3.2275a5.0456 5.0456 0 00-5.0262 5.0455v1.4876H5.787a.9672.9672 0 00-.9647.9643v9.1887a.9672.9672 0 00.9647.9643H18.213a.9672.9672 0 00.9643-.9643v-9.1907a.9672.9672 0 00-.9643-.9623h-1.1684v-1.4876a5.0456 5.0456 0 00-5.0649-5.0455zm.0127 2.8933a2.1522 2.1522 0 012.1593 2.1522v1.4876H9.8473v-1.4876a2.1522 2.1522 0 012.145-2.1522zm7.3812.5033a.8829.8829 0 10.0705 1.7632h3.0267a.8829.8829 0 000-1.7609H19.444a.8829.8829 0 00-.0705-.0023zm-17.8444.0023a.8829.8829 0 000 1.7609h2.9983a.8829.8829 0 000-1.7609zm10.4596 6.7746a1.2792 1.2792 0 01.641 2.3926v1.2453a.6298.6298 0 01-1.2595 0v-1.2453a1.2792 1.2792 0 01.6185-2.3926z" />
    </svg>
  );
}

function S3Icon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M12 10v12" />
      <path d="M18 16l-6-3-6 3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Tech item type                                                     */
/* ------------------------------------------------------------------ */

interface TechItem {
  name: string;
  url?: string;
  icon?: ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Feature data                                                      */
/* ------------------------------------------------------------------ */

const features: {
  title: string;
  description: string;
  details: string[];
  icon: ReactNode;
  tech: TechItem[];
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
    tech: [
      { name: "Git", url: "https://git-scm.com", icon: <GitIcon /> },
      { name: "Docker", url: "https://docker.com", icon: <DockerIcon /> },
      { name: "Compose", url: "https://docs.docker.com/compose", icon: <DockerIcon /> },
    ],
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
    tech: [
      { name: "Traefik", url: "https://traefik.io", icon: <TraefikIcon /> },
      { name: "Let's Encrypt", url: "https://letsencrypt.org", icon: <LetsEncryptIcon /> },
    ],
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
    tech: [
      { name: "WebAuthn", url: "https://webauthn.io", icon: <KeyIcon /> },
      { name: "AES-256" },
      { name: "Redis", url: "https://redis.io", icon: <RedisIcon /> },
    ],
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
    tech: [
      { name: "S3", url: "https://aws.amazon.com/s3", icon: <S3Icon /> },
      { name: "R2", url: "https://developers.cloudflare.com/r2", icon: <CloudflareIcon /> },
      { name: "B2", url: "https://backblaze.com/cloud-storage", icon: <BackblazeIcon /> },
    ],
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
    tech: [
      { name: "cAdvisor", url: "https://github.com/google/cadvisor" },
      { name: "Loki", url: "https://grafana.com/oss/loki", icon: <LokiIcon /> },
    ],
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
    tech: [
      { name: "Git branches", url: "https://git-scm.com", icon: <GitIcon /> },
      { name: "Compose", url: "https://docs.docker.com/compose", icon: <DockerIcon /> },
    ],
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
    tech: [
      { name: "YAML" },
      { name: "Portable" },
    ],
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
    tech: [
      { name: "REST" },
      { name: "CLI" },
      { name: "MCP", url: "https://modelcontextprotocol.io" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Tech chip component                                                */
/* ------------------------------------------------------------------ */

function TechChip({ item }: { item: TechItem }) {
  const inner = (
    <>
      {item.icon && (
        <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
          {item.icon}
        </span>
      )}
      {item.name}
    </>
  );

  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener"
        className="inline-flex items-center gap-1.5 font-mono text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
      >
        {inner}
      </a>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-neutral-500">
      {inner}
    </span>
  );
}

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
          <TechChip key={t.name} item={t} />
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
