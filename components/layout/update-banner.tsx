"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import type { VersionData } from "@/lib/types/version";

const DISMISS_KEY = "vardo-update-dismissed";

function getDismissedVersion() {
  return localStorage.getItem(DISMISS_KEY);
}

function subscribeToStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export function UpdateBanner({ data }: { data: VersionData | null }) {
  const dismissedVersion = useSyncExternalStore(
    subscribeToStorage,
    getDismissedVersion,
    () => null
  );

  const dismissed = dismissedVersion === data?.latestVersion;

  function handleDismiss() {
    if (!data) return;
    localStorage.setItem(DISMISS_KEY, data.latestVersion);
    // Dispatch a storage event so useSyncExternalStore picks up the change
    // (storage events only fire cross-tab by default)
    window.dispatchEvent(new StorageEvent("storage", { key: DISMISS_KEY }));
  }

  if (!data?.hasUpdate || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="bg-primary/10 border-b border-primary/20 px-5 lg:px-10 py-2.5"
    >
      <div className="mx-auto max-w-screen-xl flex items-center justify-between gap-4">
        <p className="text-sm text-foreground">
          Vardo {data.latestVersion} is available.{" "}
          <a
            href={data.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            See what&apos;s new
          </a>{" "}
          and run{" "}
          <code className="text-xs bg-primary/10 px-1.5 py-0.5 rounded font-mono">
            sudo bash /opt/vardo/install.sh update
          </code>{" "}
          to upgrade.
        </p>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss update notification"
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
