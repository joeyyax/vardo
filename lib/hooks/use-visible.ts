import { useState, useEffect } from "react";

/**
 * Returns a key that changes whenever tab visibility changes.
 * Use as a dependency in effects that manage SSE/WebSocket connections
 * to automatically disconnect when hidden and reconnect when visible.
 *
 * The effect should check `document.hidden` at the top and return early
 * if the tab is not visible.
 */
export function useVisibilityKey(): number {
  const [key, setKey] = useState(0);

  useEffect(() => {
    function handleVisibility() {
      setKey((k) => k + 1);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  return key;
}
