import { ArrowRight, Lock } from "lucide-react";
import { severityLabel, type ServiceUpdate } from "./update-row";

/**
 * Core service rows, read-only. The registry check still runs so a maintainer
 * can see Vardo lagging upstream, but the tags come from files Vardo ships.
 */
export function SelfManagedUpdates({
  title,
  services,
}: {
  title: string;
  services: ServiceUpdate[];
}) {
  const behind = services.filter(
    (entry) => entry.status === "update" || entry.status === "drift",
  );

  return (
    <section
      aria-label={`Vardo-managed images for ${title}`}
      className="squircle rounded-lg bg-card shadow-card dark:border divide-y"
    >
      <header className="flex items-center gap-2 px-4 py-2.5">
        <Lock className="size-3.5 text-muted-foreground/50" aria-hidden="true" />
        <h2 className="type-label text-muted-foreground/60">{title}</h2>
        <span className="type-label text-muted-foreground/50">
          {behind.length === 0
            ? "matching upstream"
            : `${behind.length} behind upstream`}
        </span>
      </header>

      {behind.map((entry) => (
        <div
          key={entry.service ?? entry.image}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
        >
          <span className="font-mono text-xs text-muted-foreground">
            {entry.service ?? entry.image}
          </span>
          <span className="whitespace-nowrap font-mono text-sm text-muted-foreground">
            {entry.currentTag}
          </span>
          <ArrowRight className="size-3 text-muted-foreground/40" aria-hidden="true" />
          <span className="whitespace-nowrap font-mono text-sm">
            {entry.latestTag ?? entry.majorAvailable ?? "rebuilt"}
          </span>
          <span className="type-label text-muted-foreground/50">{severityLabel(entry)}</span>
        </div>
      ))}

      <p className="px-4 py-2.5 type-body-sm text-muted-foreground">
        Vardo pins these images and rewrites them on every restart. They move with the next Vardo
        release.
      </p>
    </section>
  );
}
