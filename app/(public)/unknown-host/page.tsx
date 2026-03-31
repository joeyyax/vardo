"use client";

import { useState } from "react";

/**
 * Self-contained error page for unknown hosts.
 *
 * IMPORTANT: This page uses inline styles because Traefik's path rewrite
 * middleware rewrites ALL paths (including /_next/static/css/...) to /unknown-host.
 * External CSS will never load, so styles must be inlined.
 */
export default function UnknownHostPage() {
  const [hovered, setHovered] = useState(false);
  const [clicked, setClicked] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100dvh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0a0a0a",
        color: "#fafafa",
        fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
        <svg
          onClick={() => setClicked(true)}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 80 96"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            width: "80px",
            height: "80px",
            color: "rgba(255,255,255,0.2)",
            cursor: "pointer",
            animation: "float 3s ease-in-out infinite",
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <style>{`
            @keyframes float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-8px); }
            }
          `}</style>
          <rect x="0" y="0" width="80" height="96" fill="transparent" stroke="none" style={{ pointerEvents: "all" }} />
          {/* Ghost body */}
          <path d="M16 40c0-13.3 10.7-24 24-24s24 10.7 24 24v40l-8-8-8 8-8-8-8 8-8-8-8 8V40Z" />
          {/* Eyes */}
          <circle cx="33" cy="45" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="47" cy="45" r="2.5" fill="currentColor" stroke="none" />
          {/* Mouth */}
          <path
            d={hovered ? "M36 56q4 3 8 0" : "M36 56h8"}
            style={{ transition: "d 400ms ease-in-out" }}
          />
        </svg>
        <p
          style={{
            fontSize: "14px",
            opacity: clicked ? 1 : 0,
            transition: "opacity 300ms",
            color: "rgba(255,255,255,0.5)",
          }}
        >
          there&apos;s nothing here
        </p>
      </div>
    </div>
  );
}
