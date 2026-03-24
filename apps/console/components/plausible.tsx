"use client";

import Script from "next/script";

export function PlausibleTracker() {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
  const src = process.env.NEXT_PUBLIC_PLAUSIBLE_SRC || "https://plausible.io/js/script.js";

  if (!domain) return null;

  return <Script defer data-domain={domain} src={src} />;
}
