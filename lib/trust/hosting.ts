// Hosting provider and region from cloud metadata, and what the provider's public certificate covers.

import { readFile } from "fs/promises";
import type { Judgement } from "./types";

export type Certification = {
  standard: string;
  /** Certificate number, when the provider publishes one. */
  number: string | null;
  url: string;
  /** Location codes the certificate lists. Null when Vardo doesn't hold the scope. */
  sites: string[] | null;
};

export type Provider = {
  key: string;
  name: string;
  certification: Certification;
  /** Location code -> display name. */
  locations: Record<string, string>;
};

export const PROVIDERS: Provider[] = [
  {
    key: "hetzner",
    name: "Hetzner Online",
    certification: {
      standard: "ISO/IEC 27001",
      number: "ZN-2025-35",
      url: "https://cdn.hetzner.com/assets/downloads/ISO-Certificate.pdf",
      sites: ["nbg1", "fsn1", "hel1"],
    },
    locations: {
      nbg1: "Nuremberg, Germany",
      fsn1: "Falkenstein, Germany",
      hel1: "Tuusula, Finland",
      ash: "Ashburn, Virginia",
      hil: "Hillsboro, Oregon",
      sin: "Singapore",
    },
  },
  {
    key: "aws",
    name: "AWS EC2",
    certification: {
      standard: "ISO/IEC 27001",
      number: null,
      url: "https://aws.amazon.com/compliance/iso-27001-faqs/",
      sites: null,
    },
    locations: {},
  },
];

export type Hosting = {
  provider: string;
  /** Provider's own region or zone string. */
  region: string | null;
  /** Normalized location code for providers with a known site list. */
  location: string | null;
  source: "detected" | "manual";
};

export function findProvider(name: string): Provider | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return PROVIDERS.find((p) => p.key === needle || p.name.toLowerCase() === needle || p.name.toLowerCase().startsWith(needle)) ?? null;
}

/** Hetzner zones look like `hel1-dc2`; the location code is the part before the dash. */
export function hetznerLocation(zone: string): string | null {
  const code = zone.trim().toLowerCase().split("-")[0];
  return code in (PROVIDERS[0].locations) ? code : null;
}

/** Resolves a hand-typed region to a location code by code or display name. */
export function matchLocation(provider: Provider, region: string): string | null {
  const needle = region.trim().toLowerCase();
  if (!needle) return null;
  const code = needle.split("-")[0];
  if (code in provider.locations) return code;
  for (const [key, label] of Object.entries(provider.locations)) {
    if (label.toLowerCase().includes(needle) || needle.includes(label.split(",")[0].toLowerCase())) return key;
  }
  return null;
}

export function locationLabel(provider: Provider | null, hosting: Pick<Hosting, "region" | "location">): string | null {
  if (provider && hosting.location && provider.locations[hosting.location]) return provider.locations[hosting.location];
  return hosting.region;
}

export function judgeProviderCert(hosting: Hosting | null): Judgement {
  if (!hosting) return { state: "unknown", evidence: "Provider not detected." };
  const provider = findProvider(hosting.provider);
  if (!provider) return { state: "unknown", evidence: `${hosting.provider}: Vardo doesn't hold this provider's certificate scope.` };
  const cert = provider.certification;
  if (!cert.sites) {
    return { state: "unknown", evidence: `${provider.name}: Vardo doesn't hold the ${cert.standard} site list. Compare ${hosting.region ?? "your region"} against the published certificate.` };
  }
  if (!hosting.location) {
    return { state: "unknown", evidence: `${provider.name}: the location ${hosting.region ?? ""} couldn't be matched to a certified site.`.replace("  ", " ") };
  }
  const where = provider.locations[hosting.location] ?? hosting.location;
  const listed = cert.sites.map((s) => provider.locations[s].split(",")[0]).join(", ");
  if (cert.sites.includes(hosting.location)) {
    return { state: "passing", evidence: `${cert.standard} certificate lists ${where}.` };
  }
  return { state: "failing", evidence: `${cert.standard} certificate lists ${listed}, not ${where}.` };
}

const METADATA_TIMEOUT_MS = 1500;

async function fetchText(url: string, init: RequestInit = {}): Promise<string | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** `key: value` lines, as Hetzner's metadata returns them. */
export function parseHetznerMetadata(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^([\w-]+):\s*(.+)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

async function detectHetzner(): Promise<Hosting | null> {
  const body = await fetchText("http://169.254.169.254/hetzner/v1/metadata");
  if (!body) return null;
  const meta = parseHetznerMetadata(body);
  const zone = meta["availability-zone"] ?? meta["region"] ?? null;
  return { provider: "Hetzner Online", region: zone, location: zone ? hetznerLocation(zone) : null, source: "detected" };
}

async function detectAws(): Promise<Hosting | null> {
  const token = await fetchText("http://169.254.169.254/latest/api/token", {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
  });
  if (!token) return null;
  const region = await fetchText("http://169.254.169.254/latest/meta-data/placement/region", {
    headers: { "X-aws-ec2-metadata-token": token },
  });
  if (!region) return null;
  return { provider: "AWS EC2", region: region.trim(), location: null, source: "detected" };
}

/** The host's DMI vendor, readable without network when metadata is unreachable. */
async function dmiVendor(): Promise<string | null> {
  try {
    return (await readFile("/sys/class/dmi/id/sys_vendor", "utf8")).trim();
  } catch {
    return null;
  }
}

/** Reads cloud metadata. Null when the host isn't Hetzner or AWS EC2, or neither answers. */
export async function detectHosting(): Promise<Hosting | null> {
  const hetzner = await detectHetzner();
  if (hetzner) return hetzner;
  const aws = await detectAws();
  if (aws) return aws;
  const vendor = (await dmiVendor())?.toLowerCase() ?? "";
  if (vendor.includes("hetzner")) return { provider: "Hetzner Online", region: null, location: null, source: "detected" };
  if (vendor.includes("amazon")) return { provider: "AWS EC2", region: null, location: null, source: "detected" };
  return null;
}

/** A hand-set provider and region, matched against the known providers. */
export function manualHosting(input: { provider: string; region: string }): Hosting | null {
  const provider = input.provider.trim();
  if (!provider) return null;
  const known = findProvider(provider);
  return {
    provider: known?.name ?? provider,
    region: input.region.trim() || null,
    location: known ? matchLocation(known, input.region) : null,
    source: "manual",
  };
}
