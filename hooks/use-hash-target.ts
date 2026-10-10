"use client";

import { useEffect, useState } from "react";

/** How long a linked item stays highlighted. */
const HIGHLIGHT_MS = 2400;

/**
 * Scrolls to the element the URL hash names once `ready` (its list has loaded), and returns that id
 * while it should read as highlighted. Client-rendered lists miss the browser's own hash scroll.
 */
export function useHashTarget(ready: boolean): string | null {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    const frame = requestAnimationFrame(() => setTarget(id));
    const timer = setTimeout(() => setTarget(null), HIGHLIGHT_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [ready]);

  return target;
}
