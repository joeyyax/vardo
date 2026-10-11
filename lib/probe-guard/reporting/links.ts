// Client-safe names and public lookup links for reporters.

export const REPORTER_LINKS: Record<string, { label: string; checkUrl: (ip: string) => string }> = {
  abuseipdb: { label: "AbuseIPDB", checkUrl: (ip) => `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}` },
};

export function reporterLink(id: string, ip: string): { label: string; url: string } | null {
  const r = REPORTER_LINKS[id];
  return r ? { label: r.label, url: r.checkUrl(ip) } : null;
}
