import type { NextConfig } from "next";
import { execSync } from "child_process";
import { resolve } from "path";
import { config } from "dotenv";

// Load .env from repo root
config({ path: "./.env", quiet: true });

let gitSha = "";
try {
  gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
  // Not in a git repo or git not available
}

const nextConfig: NextConfig = {
  // CLAUDE.md is hand-written; `next dev` would otherwise rewrite it.
  agentRules: false,
  outputFileTracingRoot: resolve(__dirname),
  env: {
    NEXT_PUBLIC_GIT_SHA: gitSha || process.env.NEXT_PUBLIC_GIT_SHA || "",
  },
  // Matches PROXY_BODY_LIMIT_BYTES; the image ships next.config.ts without lib/.
  experimental: { proxyClientMaxBodySize: 32 * 1024 * 1024 },
  serverExternalPackages: ["node-ical", "nodemailer", "@modelcontextprotocol/sdk"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
  async headers() {
    return [
      {
        // Default security headers for all routes
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "0" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
