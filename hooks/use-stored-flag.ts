"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
// Holds the value when storage is blocked.
const memory = new Map<string, boolean>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read(key: string): boolean {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** A per-viewer boolean kept in localStorage. Reads false on the server and when storage is blocked. */
export function useStoredFlag(key: string): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key), () => false);
  const set = useCallback(
    (next: boolean) => {
      memory.set(key, next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage blocked; the in-memory value holds for this visit.
      }
      listeners.forEach((fn) => fn());
    },
    [key],
  );
  return [value, set];
}
