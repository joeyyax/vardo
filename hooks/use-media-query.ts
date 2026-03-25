import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    const id = requestAnimationFrame(() => setMatches(mql.matches));
    mql.addEventListener("change", handler);
    return () => {
      cancelAnimationFrame(id);
      mql.removeEventListener("change", handler);
    };
  }, [query]);

  return matches;
}
