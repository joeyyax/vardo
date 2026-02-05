import { headers } from "next/headers";

/**
 * Simple rate limiting using in-memory store.
 * For production, use Redis or a proper rate limiting service.
 */
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

type RateLimitConfig = {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
};

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30, // 30 requests per minute
};

const STRICT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
};

/**
 * Get client IP from request headers.
 * Handles common proxy headers.
 */
export async function getClientIP(): Promise<string> {
  const headersList = await headers();

  // Check common proxy headers
  const forwardedFor = headersList.get("x-forwarded-for");
  if (forwardedFor) {
    // Take the first IP if there are multiple
    return forwardedFor.split(",")[0].trim();
  }

  const realIP = headersList.get("x-real-ip");
  if (realIP) {
    return realIP;
  }

  // Cloudflare
  const cfIP = headersList.get("cf-connecting-ip");
  if (cfIP) {
    return cfIP;
  }

  return "unknown";
}

/**
 * Get request metadata for logging.
 */
export async function getRequestMetadata() {
  const headersList = await headers();

  return {
    ip: await getClientIP(),
    userAgent: headersList.get("user-agent") || "unknown",
    referer: headersList.get("referer") || null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check rate limit for a given key.
 * Returns true if request is allowed, false if rate limited.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const record = rateLimitStore.get(key);

  // Clean up old entries periodically
  if (Math.random() < 0.01) {
    cleanupRateLimitStore();
  }

  if (!record || now > record.resetAt) {
    // New window
    const resetAt = now + config.windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: config.maxRequests - 1, resetAt };
  }

  if (record.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  record.count++;
  return { allowed: true, remaining: config.maxRequests - record.count, resetAt: record.resetAt };
}

/**
 * Rate limit for public endpoints (stricter).
 */
export async function checkPublicRateLimit(): Promise<{ allowed: boolean; remaining: number }> {
  const ip = await getClientIP();
  const key = `public:${ip}`;
  return checkRateLimit(key, STRICT_RATE_LIMIT);
}

/**
 * Rate limit for authenticated endpoints.
 */
export async function checkAuthRateLimit(userId?: string): Promise<{ allowed: boolean; remaining: number }> {
  const ip = await getClientIP();
  const key = userId ? `auth:${userId}` : `auth:${ip}`;
  return checkRateLimit(key, DEFAULT_RATE_LIMIT);
}

/**
 * Clean up expired rate limit entries.
 */
function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Validate that a token looks legitimate (correct format/entropy).
 */
export function isValidToken(token: string, expectedLength: number = 32): boolean {
  if (!token || typeof token !== "string") {
    return false;
  }

  // Check length
  if (token.length !== expectedLength) {
    return false;
  }

  // Check character set (nanoid uses A-Za-z0-9_-)
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return false;
  }

  return true;
}

/**
 * Log a security-relevant event.
 * In production, this could write to a dedicated audit log.
 */
export async function logSecurityEvent(
  event: string,
  details: Record<string, unknown>
) {
  const metadata = await getRequestMetadata();

  // For now, just console log. In production, write to database or logging service.
  console.log(JSON.stringify({
    type: "security_event",
    event,
    ...metadata,
    details,
  }));
}

/**
 * Check if request looks like a bot.
 * Simple heuristics - not foolproof but catches low-effort bots.
 */
export async function looksLikeBot(): Promise<boolean> {
  const headersList = await headers();
  const userAgent = headersList.get("user-agent") || "";

  // No user agent is suspicious
  if (!userAgent) {
    return true;
  }

  // Common bot patterns
  const botPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /curl/i,
    /wget/i,
    /python-requests/i,
    /httpclient/i,
    /java\//i,
    /libwww/i,
  ];

  for (const pattern of botPatterns) {
    if (pattern.test(userAgent)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a simple proof-of-work challenge.
 * Client must find a nonce where SHA256(challenge + nonce) starts with N zeros.
 */
export function generatePowChallenge(difficulty: number = 4): { challenge: string; difficulty: number } {
  const challenge = crypto.randomUUID();
  return { challenge, difficulty };
}

/**
 * Verify a proof-of-work solution.
 */
export async function verifyPowSolution(
  challenge: string,
  nonce: string,
  difficulty: number
): Promise<boolean> {
  const data = challenge + nonce;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  // Check if hash starts with required number of zeros
  const prefix = "0".repeat(difficulty);
  return hashHex.startsWith(prefix);
}
