import type { NextConfig } from "next";
import { execSync } from "child_process";

let gitSha = "";
try {
  gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
  // Not in a git repo or git not available
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GIT_SHA: gitSha,
  },
  serverExternalPackages: ["node-ical"],
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
        ],
      },
      {
        // Allow the widget bridge to be iframed from any origin
        // (overrides the default X-Frame-Options for this route)
        source: "/widget/bridge",
        headers: [
          { key: "X-Frame-Options", value: "ALLOWALL" },
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;
