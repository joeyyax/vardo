// Environment for every docker, compose and builder process.
// Compose interpolates shell variables ahead of the project `.env`, so the console's own env must never reach it.

const KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "TZ",
  "LANG",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_BUILDKIT",
  "DOCKER_DEFAULT_PLATFORM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

// Locale, builder settings and the non-secret memory knobs Vardo's own templates read.
const KEEP_PATTERN = /^(LC_[A-Z]+|BUILDKIT_[A-Z0-9_]+|BUILDX_[A-Z0-9_]+|VARDO_[A-Z0-9_]+_MEM)$/;

/** Allowlisted entries of `source`, plus `extra`. */
export function dockerEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (KEEP.has(key) || KEEP_PATTERN.test(key))) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}
