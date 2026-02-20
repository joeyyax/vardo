"use client";

import { useEffect } from "react";

export function PlausibleTracker() {
  useEffect(() => {
    import("@plausible-analytics/tracker").then(({ init }) => {
      init({
        domain: process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? "usescope.net",
        endpoint: `${process.env.NEXT_PUBLIC_PLAUSIBLE_HOST ?? "https://analytics.joeyyax.app"}/api/event`,
        captureOnLocalhost: false,
      });
    });
  }, []);

  return null;
}
