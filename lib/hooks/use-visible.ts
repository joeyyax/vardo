import { useState, useEffect } from "react";

/**
 * Returns a key that changes when the tab has been hidden for more than
 * `delayMs` (default 5s) or becomes visible again. Use as a dependency
 * in effects that manage SSE/WebSocket connections.
 *
 * The delay prevents thrashing on quick tab switches (cmd-tab, etc).
 */
export function useVisibilityKey(delayMs = 5000): number {
  const [key, setKey] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function handleVisibility() {
      if (document.hidden) {
        // Delay disconnect so quick tab switches don't thrash
        timer = setTimeout(() => setKey((k) => k + 1), delayMs);
      } else {
        // Reconnect immediately when visible
        if (timer) { clearTimeout(timer); timer = null; }
        setKey((k) => k + 1);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [delayMs]);

  return key;
}
