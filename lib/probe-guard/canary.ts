// Decoy .env values with a per-fetch marker. Every value is malformed on purpose, so none can be a working credential anywhere.

import { randomBytes } from "crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const MARKER_RE = /^[a-z2-7]{12}$/;

/** Twelve random base32 characters. */
export function generateMarker(bytes: Buffer = randomBytes(12)): string {
  return [...bytes.subarray(0, 12)].map((b) => ALPHABET[b % 32]).join("");
}

/** The values a decoy carries for a marker. Underscores, `.invalid` hosts and EXAMPLE tags keep them unusable. */
export function canaryValues(marker: string): Record<string, string> {
  if (!MARKER_RE.test(marker)) throw new Error("Invalid canary marker");
  const upper = marker.toUpperCase();
  return {
    APP_ENV: "production",
    APP_DEBUG: "false",
    DATABASE_URL: `postgres://admin_${marker}:pw_${marker}@db.example.invalid:5432/app`,
    AWS_ACCESS_KEY_ID: `AKIA_${upper}_EXAMPLE`,
    AWS_SECRET_ACCESS_KEY: `example_${marker}_not_a_secret`,
    AWS_DEFAULT_REGION: "us-example-1",
    ADMIN_USER: `admin_${marker}`,
    ADMIN_PASSWORD: `example_${marker}`,
    SECRET_KEY: `example_${marker}_${"0".repeat(16)}`,
  };
}

export function renderDecoyEnv(marker: string): string {
  return `${Object.entries(canaryValues(marker)).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}

/** Usernames a decoy suggests for basic auth. */
export function canaryUsernames(marker: string): string[] {
  const v = canaryValues(marker);
  return [v.ADMIN_USER, v.AWS_ACCESS_KEY_ID];
}

/** The fixed base64 prefix of `user:` that any basic-auth header for this user starts with. */
export function basicAuthPrefix(username: string): string {
  const raw = Buffer.from(`${username}:`, "utf-8");
  const whole = raw.subarray(0, raw.length - (raw.length % 3));
  return whole.toString("base64");
}

/** The marker found in a value, from the given set, or null. Values are read and dropped, never kept. */
export function findMarker(value: string, markers: readonly string[]): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m)) return m;
    for (const user of new Set(canaryUsernames(m))) {
      if (value.includes(basicAuthPrefix(user))) return m;
    }
  }
  return null;
}

/** Query keys a stolen credential tends to arrive in. */
export const CANARY_QUERY_KEYS = [
  "key", "api_key", "apikey", "token", "access_token", "access_key", "password", "pass", "pwd",
  "user", "username", "AWSAccessKeyId", "X-Amz-Credential", "secret",
];

/** Headers a stolen credential tends to arrive in. */
export const CANARY_HEADERS = ["Authorization", "Proxy-Authorization", "X-Api-Key", "X-Amz-Security-Token", "X-Auth-Token", "Cookie"];

/** Regex alternation that matches any marker or its basic-auth prefixes. */
export function canaryRegexp(markers: readonly string[]): string {
  const parts = new Set<string>();
  for (const m of markers) {
    if (!MARKER_RE.test(m)) continue;
    parts.add(m);
    for (const user of canaryUsernames(m)) parts.add(basicAuthPrefix(user).replace(/[+/=]/g, (c) => `\\${c}`));
  }
  return [...parts].join("|");
}
