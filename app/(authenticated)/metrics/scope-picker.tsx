"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Loader2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/messenger";
import { switchOrganization } from "@/lib/organizations/switch";

type ScopePickerProps = {
  /** "server" or the selected organization's id. */
  value: string;
  canServer: boolean;
  orgs: { id: string; name: string }[];
  currentOrgId: string;
};

export function ScopePicker({ value, canServer, orgs, currentOrgId }: ScopePickerProps) {
  const router = useRouter();
  const label = value === "server" ? "Whole server" : (orgs.find((o) => o.id === value)?.name ?? "Organization");

  async function choose(next: string) {
    if (next === value) return;
    if (next !== "server" && next !== currentOrgId) {
      const result = await switchOrganization(next);
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't switch organization");
        return;
      }
    }
    router.push(`/metrics?scope=${next}`);
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-auto px-3 py-1.5 gap-1.5 font-medium" aria-label="Metrics scope">
          <span className="truncate text-sm">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {canServer && (
          <>
            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => choose("server")}>
              <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
                <Server className="size-3" />
              </div>
              <span className="truncate">Whole server</span>
              {value === "server" && <Check className="ml-auto size-4 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
        {orgs.map((org) => (
          <DropdownMenuItem key={org.id} className="gap-2 cursor-pointer" onClick={() => choose(org.id)}>
            <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
              <Building2 className="size-3" />
            </div>
            <span className="truncate">{org.name}</span>
            {org.id === value && <Check className="ml-auto size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Makes a linked organization the active one, then reloads the page on it. */
export function ScopeSwitch({ orgId }: { orgId: string }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    switchOrganization(orgId).then((result) => {
      if (cancelled) return;
      if (result.ok) router.refresh();
      else {
        toast.error(result.error ?? "Couldn't switch organization");
        router.replace("/metrics");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, router]);

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Switching organization…
    </div>
  );
}
