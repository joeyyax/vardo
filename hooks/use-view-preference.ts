"use client";

import { useState, useCallback } from "react";
import type { ViewType } from "@/lib/views";

const STORAGE_PREFIX = "time-view-";

function getStoredView<T extends ViewType>(
  pageKey: string,
  allowedViews: readonly T[],
  defaultView: T
): T {
  if (typeof window === "undefined") return defaultView;
  const stored = localStorage.getItem(STORAGE_PREFIX + pageKey);
  if (stored && allowedViews.includes(stored as T)) return stored as T;
  return defaultView;
}

export function useViewPreference<T extends ViewType>(
  pageKey: string,
  allowedViews: readonly T[],
  defaultView: T
): [T, (view: T) => void] {
  const [view, setViewState] = useState<T>(() =>
    getStoredView(pageKey, allowedViews, defaultView)
  );

  const setView = useCallback(
    (newView: T) => {
      setViewState(newView);
      localStorage.setItem(STORAGE_PREFIX + pageKey, newView);
    },
    [pageKey]
  );

  return [view, setView];
}
