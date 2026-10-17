// Addresses a vantage point must not check: private, loopback, link-local and tunnel ranges.

import net from "node:net";
import type { Check } from "./types";

export type Cidr = [string, number];

const V4: Cidr[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

function v4Number(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function inCidr(ip: string, [base, bits]: Cidr): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v4Number(ip) & mask) >>> 0) === ((v4Number(base) & mask) >>> 0);
}

/** True for addresses outside the public internet, plus any `extra` ranges. Anything that isn't an IP address counts as private. */
export function isPrivateAddress(address: string, extra: Cidr[] = []): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(ip);
  if (family === 4) return [...V4, ...extra].some((c) => inCidr(ip, c));
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1], extra);
    if (lower === "::" || lower === "::1") return true;
    return /^(fc|fd)/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true;
}

/** The host a check connects to. */
export function checkHost(check: Check): string {
  if (check.type !== "http") return check.host;
  try {
    return new URL(check.url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

const INTERNAL_NAME = /^localhost$|\.(local|localhost|internal|lan|home|corp|intranet)$|^[^.]+$/i;

/** Names that never resolve on the public internet: reserved suffixes and bare hostnames. */
const NEVER_PUBLIC = /(^|\.)(localhost|local|internal|test|lan)$|^[^.]+$/i;

/** True for a domain no outside vantage point could reach, such as `app.localhost` or `nas`. */
export function isNeverPublic(host: string): boolean {
  return net.isIP(host) === 0 && NEVER_PUBLIC.test(host);
}

/** A name that can't be public, judged without a lookup. */
export function isInternalName(host: string): boolean {
  return net.isIP(host) === 0 && INTERNAL_NAME.test(host);
}
