"use client";

import { useEffect } from "react";
import { init } from "@plausible-analytics/tracker";

export function PlausibleTracker() {
  useEffect(() => {
    init({
      domain: process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? "usescope.net",
      endpoint: `${process.env.NEXT_PUBLIC_PLAUSIBLE_HOST ?? "https://analytics.joeyyax.app"}/api/event`,
      captureOnLocalhost: false,
    });
  }, []);

  return null;
}
