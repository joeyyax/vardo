import type { SecurityFinding } from "./types";

type HeaderCheck = {
  header: string;
  severity: SecurityFinding["severity"];
  title: string;
  description: string;
  /** Return true if the header value is acceptable. */
  validate?: (value: string) => boolean;
};

const HEADER_CHECKS: HeaderCheck[] = [
  {
    header: "strict-transport-security",
    severity: "critical",
    title: "Missing Strict-Transport-Security header",
    description:
      "HSTS is not set. Browsers may connect over HTTP before being redirected, enabling man-in-the-middle attacks.",
  },
  {
    header: "content-security-policy",
    severity: "warning",
    title: "Missing Content-Security-Policy header",
    description:
      "No CSP is set. This increases exposure to cross-site scripting (XSS) attacks.",
  },
  {
    header: "x-content-type-options",
    severity: "warning",
    title: "Missing X-Content-Type-Options header",
    description:
      "X-Content-Type-Options: nosniff is not set. Browsers may MIME-sniff responses, enabling XSS vectors.",
    validate: (v) => v.toLowerCase().includes("nosniff"),
  },
  {
    header: "x-frame-options",
    severity: "warning",
    title: "Missing framing protection",
    description:
      "Neither X-Frame-Options nor a CSP frame-ancestors directive is set, leaving the app vulnerable to clickjacking.",
  },
  {
    header: "referrer-policy",
    severity: "info",
    title: "Missing Referrer-Policy header",
    description:
      "No Referrer-Policy is set. Sensitive URL parameters may leak to third-party sites via the Referer header.",
  },
  {
    header: "permissions-policy",
    severity: "info",
    title: "Missing Permissions-Policy header",
    description:
      "No Permissions-Policy is set. Browser features such as camera, microphone, and geolocation are not explicitly restricted.",
  },
];

const TIMEOUT_MS = 5_000;

/**
 * Check HTTP security headers on a deployed domain.
 * Returns SecurityFinding[] for each missing or misconfigured header.
 */
export async function checkSecurityHeaders(domain: string): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  let headers: Headers;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`https://${domain}`, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timer);
    headers = res.headers;
  } catch {
    // Network error — skip header check silently
    return findings;
  }

  const csp = headers.get("content-security-policy") ?? "";
  const hasFrameAncestors = csp.toLowerCase().includes("frame-ancestors");

  for (const check of HEADER_CHECKS) {
    const value = headers.get(check.header);

    // X-Frame-Options check: satisfied by either X-Frame-Options or CSP frame-ancestors
    if (check.header === "x-frame-options") {
      if (!value && !hasFrameAncestors) {
        findings.push({
          type: "missing-header",
          severity: check.severity,
          title: check.title,
          description: check.description,
          detail: check.header,
        });
      }
      continue;
    }

    if (!value) {
      findings.push({
        type: "missing-header",
        severity: check.severity,
        title: check.title,
        description: check.description,
        detail: check.header,
      });
      continue;
    }

    if (check.validate && !check.validate(value)) {
      findings.push({
        type: "missing-header",
        severity: check.severity,
        title: check.title.replace("Missing", "Misconfigured"),
        description: check.description,
        detail: check.header,
      });
    }
  }

  return findings;
}
