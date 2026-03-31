import * as tls from "tls";
import { assertPublicDomain } from "./validate-domain";
import type { SecurityFinding } from "./types";

const TLS_EXPIRY_WARNING_DAYS = 14;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Verify TLS certificate validity and check for upcoming expiry on a domain.
 * Returns SecurityFinding[] for cert errors or imminent expiry.
 */
export async function checkTls(domain: string): Promise<SecurityFinding[]> {
  await assertPublicDomain(domain);

  return new Promise((resolve) => {
    const findings: SecurityFinding[] = [];
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(findings);
    };

    const timer = setTimeout(() => {
      if (!settled) done();
    }, CONNECT_TIMEOUT_MS);

    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
      () => {
        clearTimeout(timer);

        try {
          const cert = socket.getPeerCertificate();

          if (!cert || !cert.valid_to) {
            findings.push({
              type: "tls",
              severity: "critical",
              title: "TLS certificate not found",
              description: "Could not retrieve a TLS certificate from the server.",
              detail: domain,
            });
            done();
            return;
          }

          const authorized = socket.authorized;
          if (!authorized) {
            const reason = socket.authorizationError ?? "unknown";
            findings.push({
              type: "tls",
              severity: "critical",
              title: "TLS certificate is invalid",
              description: `The certificate is not trusted: ${reason}`,
              detail: domain,
            });
          }

          const expiresAt = new Date(cert.valid_to);
          const now = new Date();
          const msLeft = expiresAt.getTime() - now.getTime();
          const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));

          if (daysLeft <= 0) {
            findings.push({
              type: "tls",
              severity: "critical",
              title: "TLS certificate has expired",
              description: `The certificate for ${domain} expired on ${expiresAt.toDateString()}.`,
              detail: domain,
            });
          } else if (daysLeft <= TLS_EXPIRY_WARNING_DAYS) {
            findings.push({
              type: "tls",
              severity: "warning",
              title: `TLS certificate expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
              description: `The certificate for ${domain} expires on ${expiresAt.toDateString()}. Renew before it lapses.`,
              detail: domain,
            });
          }
        } catch {
          // Cert inspection failed — not fatal for the overall scan
        }

        done();
      },
    );

    socket.on("error", () => {
      clearTimeout(timer);
      // TLS connection errors (e.g. port 443 not open) are not surfaced as findings —
      // the app may not use TLS directly (behind a reverse proxy). Skip silently.
      done();
    });
  });
}
