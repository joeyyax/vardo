"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";

type VersionData = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
};

const DISMISS_KEY = "vardo-update-dismissed";

export function UpdateBanner() {
  const [data, setData] = useState<VersionData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch("/api/v1/admin/version")
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<VersionData>;
      })
      .then((d) => {
        if (!d) return;
        setData(d);

        const dismissedVersion = localStorage.getItem(DISMISS_KEY);
        if (dismissedVersion === d.latestVersion) {
          setDismissed(true);
        }
      })
      .catch(() => {});
  }, []);

  if (!data?.hasUpdate || dismissed) return null;

  function handleDismiss() {
    if (data) {
      localStorage.setItem(DISMISS_KEY, data.latestVersion);
    }
    setDismissed(true);
  }

  return (
    <div className="bg-primary/10 border-b border-primary/20 px-5 lg:px-10 py-2.5">
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
