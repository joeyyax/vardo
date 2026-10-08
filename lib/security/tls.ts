import * as tls from "tls";
import { assertPublicDomain } from "./validate-domain";
import { guardedLookup } from "./pinned-fetch";
import type { SecurityFinding } from "./types";

const TLS_EXPIRY_WARNING_DAYS = 14;
const CONNECT_TIMEOUT_MS = 5_000;

/** Checks a domain's TLS certificate for errors and imminent expiry. */
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
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false, lookup: guardedLookup(false) as never },
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
          // Not fatal for the scan.
        }

        done();
      },
    );

    socket.on("error", () => {
      clearTimeout(timer);
      // Connection errors aren't findings: the app may sit behind a reverse proxy.
      done();
    });
  });
}
