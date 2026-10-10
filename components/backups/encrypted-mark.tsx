import Link from "next/link";
import { Lock } from "lucide-react";
import { Term } from "@/components/term";
import { cn } from "@/lib/utils";

/** Where the recovery key card lives. */
export const RECOVERY_KEY_HREF = "#recovery-key";

/** Small lock and "Encrypted" for a backup that was written encrypted. */
export function EncryptedMark({ href = RECOVERY_KEY_HREF, className }: { href?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <Lock className="size-3" aria-hidden="true" />
      <Term id="backup-encrypted">Encrypted</Term>
      <span aria-hidden="true">·</span>
      <Link href={href} className="underline-offset-2 hover:text-foreground hover:underline">
        Recovery key
      </Link>
    </span>
  );
}
