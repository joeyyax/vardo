import * as tls from "tls";
import type { CertProbe } from "./cert-expiry";

const CONNECT_TIMEOUT_MS = 5_000;

/** Node reports authorizationError as an Error in current releases, a bare code string in older ones. */
function errorCode(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const withCode = value as Error & { code?: string };
    return withCode.code ?? value.message;
  }
  return null;
}

/**
 * Open a TLS connection to a domain and report its peer certificate.
 * Never throws — connection failures come back as `unreachable`.
 */
export function probeCertificate(
  domain: string,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<CertProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | null = null;

    const finish = (result: CertProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: "unreachable", reason: "timeout" });
    }, timeoutMs);

    try {
      // rejectUnauthorized:false so an expired or untrusted cert still completes
      // the handshake and can be inspected.
      socket = tls.connect(
        { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
        () => {
          try {
            const cert = socket?.getPeerCertificate();
            if (!cert || Object.keys(cert).length === 0) {
              finish({ status: "unreachable", reason: "no peer certificate" });
              return;
            }
            finish({
              status: "ok",
              validTo: cert.valid_to,
              fingerprint: cert.fingerprint256 ?? cert.fingerprint ?? null,
              authorized: socket?.authorized ?? false,
              authorizationError: errorCode(socket?.authorizationError),
            });
          } catch (err) {
            finish({ status: "unreachable", reason: String(err) });
          }
        },
      );

      socket.on("error", (err: Error) => {
        finish({ status: "unreachable", reason: err.message });
      });
    } catch (err) {
      finish({ status: "unreachable", reason: String(err) });
    }
  });
}
