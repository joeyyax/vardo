import { CERT_EXPIRY_THRESHOLD_DAYS } from "@/lib/system-alerts/cert-expiry";

export type Tone = "success" | "warning" | "error" | "neutral";

export type Diagnosis<S extends string> = {
  state: S;
  label: string;
  tone: Tone;
  hint?: string;
};

/** What a DNS lookup of a domain found. */
export type DnsFacts = {
  resolved: boolean;
  ips: string[];
  /** Points at this server, directly or through a proxy that answers. */
  matches: boolean;
  proxied?: boolean;
  reachable?: boolean;
  proxyProvider?: "cloudflare" | null;
  serverIp?: string | null;
  /** The lookup itself failed. */
  failed?: boolean;
};

export type DnsState = "connected" | "proxied" | "not-responding" | "wrong-ip" | "no-records" | "error";

export function diagnoseDns(f: DnsFacts): Diagnosis<DnsState> {
  const found = f.ips.join(", ");
  if (f.failed) {
    return { state: "error", label: "Couldn't check DNS", tone: "neutral", hint: "Check again in a moment." };
  }
  if (f.resolved && f.matches && f.proxied) {
    return {
      state: "proxied",
      label: `Connected (via ${f.proxyProvider === "cloudflare" ? "Cloudflare" : "proxy"})`,
      tone: "success",
      hint: "Cloudflare's proxy covers single-level subdomains. Set nested subdomains to DNS only so a certificate can be issued.",
    };
  }
  if (f.resolved && f.matches) return { state: "connected", label: "Connected", tone: "success" };
  if (f.resolved && !f.reachable) {
    return {
      state: "not-responding",
      label: "Not responding",
      tone: "error",
      hint: `${found ? `DNS resolves to ${found}, but ` : ""}the server didn't answer. Check that ports 80 and 443 reach it.`,
    };
  }
  if (f.resolved) {
    return {
      state: "wrong-ip",
      label: "Wrong IP",
      tone: "error",
      hint: `DNS resolves to ${found}${f.serverIp ? `, not this server (${f.serverIp})` : ", not this server"}.`,
    };
  }
  return {
    state: "no-records",
    label: "DNS not configured",
    tone: "warning",
    hint: "No A or CNAME records found.",
  };
}

type DnsCheckResponse = {
  status?: string;
  resolves?: boolean;
  configured?: boolean;
  proxied?: boolean;
  reachable?: boolean;
  proxyProvider?: "cloudflare" | null;
  serverIp?: string | null;
  records?: { a?: string[]; cname?: string[] };
};

/** Normalizes a /api/v1/dns-check response. */
export function dnsFactsFromCheck(data: DnsCheckResponse): DnsFacts {
  const ips = [...(data.records?.a ?? []), ...(data.records?.cname ?? [])];
  // A local domain that didn't answer has no DNS to blame.
  if (data.status === "unreachable") {
    return { resolved: true, ips: [], matches: false, reachable: false };
  }
  if (data.status === "error") return { resolved: false, ips, matches: false, failed: true };
  return {
    resolved: !!data.resolves,
    ips,
    matches: !!data.configured,
    proxied: data.proxied,
    reachable: data.reachable,
    proxyProvider: data.proxyProvider,
    serverIp: data.serverIp,
  };
}

/** The latest certificate probe for a domain, as stored. */
export type CertCheck = {
  status: string;
  expiresAt: Date | string | null;
  checkedAt: Date | string;
};

export type CertState = "ok" | "expiring" | "expired" | "not-issued" | "unknown" | "unchecked";

const DAY_MS = 24 * 60 * 60 * 1000;

export function diagnoseCert(check: CertCheck | null | undefined, now = Date.now()): Diagnosis<CertState> {
  if (!check) {
    return { state: "unchecked", label: "Certificate not checked yet", tone: "neutral" };
  }
  if (check.status === "not-issued") {
    return {
      state: "not-issued",
      label: "No certificate issued",
      tone: "warning",
      hint: "DNS can be right and issuing still fail. Check that port 80 reaches this server and the certificate authority hasn't rate-limited it.",
    };
  }
  const expires = check.expiresAt ? new Date(check.expiresAt).getTime() : NaN;
  if (check.status === "unknown" || !Number.isFinite(expires)) {
    return { state: "unknown", label: "Couldn't read the certificate", tone: "neutral" };
  }
  const daysLeft = Math.floor((expires - now) / DAY_MS);
  if (expires <= now) {
    return { state: "expired", label: "Certificate expired", tone: "error", hint: "Traefik should renew it. Check its logs if it stays expired." };
  }
  if (daysLeft <= CERT_EXPIRY_THRESHOLD_DAYS) {
    return {
      state: "expiring",
      label: `Certificate expires in ${daysLeft === 0 ? "under a day" : `${daysLeft} day${daysLeft === 1 ? "" : "s"}`}`,
      tone: "warning",
    };
  }
  return { state: "ok", label: "Certificate valid", tone: "success", hint: `${daysLeft} days left.` };
}

const ORDER: Tone[] = ["error", "warning", "neutral", "success"];

/** The worst tone of the given ones. */
export function worstTone(...tones: Tone[]): Tone {
  return ORDER.find((t) => tones.includes(t)) ?? "neutral";
}

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-status-success",
  warning: "text-status-warning",
  error: "text-status-error",
  neutral: "text-muted-foreground",
};

export const TONE_DOT: Record<Tone, string> = {
  success: "bg-status-success",
  warning: "bg-status-warning",
  error: "bg-status-error",
  neutral: "bg-status-neutral",
};
