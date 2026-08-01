import Link from "next/link";
import { ToggleLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FeatureDisabledProps = {
  /** Feature name as it appears in Feature flags, e.g. "Metrics". */
  name: string;
  /** What the feature does once it's on. */
  description: string;
  /** Show the link to Feature flags. App admins only — the page redirects everyone else. */
  canManage?: boolean;
  className?: string;
};

/**
 * Off state for a feature that was never turned on. Not an error — never
 * style it as one. Copy comes from the caller so this stays client-safe.
 */
export function FeatureDisabled({ name, description, canManage, className }: FeatureDisabledProps) {
  return (
    <div
      className={cn(
        "squircle flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12 text-center",
        className,
      )}
    >
      <ToggleLeft className="size-8 text-muted-foreground/50" />
      <div className="space-y-1">
        <p className="type-h3">Not enabled</p>
        <p className="type-body text-muted-foreground max-w-md">
          {description}{" "}
          {canManage
            ? `Turn on ${name} to start collecting.`
            : `An admin can turn on ${name} under Feature flags.`}
        </p>
      </div>
      {canManage && (
        <Button size="sm" variant="outline" asChild>
          <Link href="/admin/settings/feature-flags">Feature flags</Link>
        </Button>
      )}
    </div>
  );
}
