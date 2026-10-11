"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut, ChevronsUpDown, Loader2, Settings, Shield, Building2, Check, Plus, Sun, Moon, Monitor, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession, signOut } from "@/lib/auth/client";
import { getInitials } from "@/lib/initials";
import { toast } from "@/lib/messenger";
import { switchOrganization } from "@/lib/organizations/switch";
import type { Organization } from "@/lib/types";
import { fetchInstances, openOnInstance, type InstancesResponse, type ListedInstance } from "@/lib/instances/client";
import { InstanceBadge } from "@/components/instances/instance-badge";

type UserMenuProps = {
  collapsed?: boolean;
  compact?: boolean;
  currentOrgId?: string;
  organizations?: Organization[];
  teamsEnabled?: boolean;
};

export function UserMenu({ collapsed, compact, currentOrgId, organizations, teamsEnabled = true }: UserMenuProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { data: session, isPending } = useSession();
  const isAdmin = !!session?.user?.isAppAdmin;

  const currentOrg = organizations?.find((o) => o.id === currentOrgId) || organizations?.[0];
  const [linked, setLinked] = useState<InstancesResponse | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const handleOpenChange = (open: boolean) => {
    if (open) fetchInstances().then((res) => res && setLinked(res));
  };

  const handleOpenInstance = async (peerId: string) => {
    setOpening(peerId);
    // On success the page navigates away.
    if (!(await openOnInstance(peerId))) setOpening(null);
  };

  const signInPeers = linked?.instances.filter((i) => i.signIn) ?? [];
  const browsePeers = linked?.instances.filter((i) => i.organizations) ?? [];

  const handleSignOut = async () => {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login");
        },
      },
    });
  };

  const handleSwitchOrg = async (orgId: string) => {
    if (orgId === currentOrg?.id) return;
    const result = await switchOrganization(orgId);
    if (result.ok) {
      router.push("/projects");
      router.refresh();
    } else {
      toast.error(result.error);
    }
  };

  if (isPending) {
    return (
      <Button
        variant="ghost"
        className={`px-2 py-1.5 h-auto ${collapsed ? "justify-center" : "justify-start gap-2"}`}
        disabled
      >
        <Loader2 className="size-6 animate-spin" />
      </Button>
    );
  }

  const user = session?.user;
  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const email = user?.email || "";

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={`px-2 py-1.5 h-auto ${collapsed ? "justify-center" : "justify-start gap-2"}`}
        >
          <Avatar className="size-7">
            <AvatarImage src={user?.image ?? undefined} alt={displayName} />
            <AvatarFallback className="text-xs bg-sidebar-accent">
              {getInitials(displayName)}
            </AvatarFallback>
          </Avatar>
          {!collapsed && !compact && (
            <>
              <div className="flex flex-col items-start gap-0 overflow-hidden">
                <span className="truncate text-sm font-medium">{displayName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {currentOrg?.name || email}
                </span>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56"
      >
        {/* Profile */}
        <DropdownMenuItem asChild className="cursor-pointer">
          <Link href="/user/settings/profile" aria-label={`Account settings for ${displayName}`} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            </span>
            <Settings className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </DropdownMenuItem>

        {/* Organizations */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center justify-between">
          <span className="type-label text-muted-foreground">
            {teamsEnabled ? "Organizations" : "Organization"}
          </span>
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
          >
            <Link href="/settings" aria-label="Organization settings">
              <Settings className="size-3.5" />
            </Link>
          </Button>
        </DropdownMenuLabel>
        {teamsEnabled && (
          <>
            {organizations?.map((org) => (
              <DropdownMenuItem
                key={org.id}
                className="gap-2 cursor-pointer"
                onClick={() => handleSwitchOrg(org.id)}
              >
                <Building2 className="size-4" />
                <span className="truncate">{org.name}</span>
                {org.id === currentOrg?.id && (
                  <Check className="ml-auto size-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem asChild className="gap-2 cursor-pointer">
              <Link href="/onboarding">
                <Plus className="size-4" />
                New organization
              </Link>
            </DropdownMenuItem>
          </>
        )}

        {browsePeers.map((peer) => (
          <RemoteOrgs key={peer.id} peer={peer} />
        ))}

        {/* Instances */}
        {signInPeers.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              <span className="type-label text-muted-foreground">Instances</span>
            </DropdownMenuLabel>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <Server className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{linked?.local.name}</span>
              <Check className="ml-auto size-4 text-primary" aria-label="Current instance" />
            </div>
            {signInPeers.map((peer) => (
              <DropdownMenuItem
                key={peer.id}
                className="gap-2 cursor-pointer"
                disabled={opening !== null}
                onSelect={(e) => {
                  e.preventDefault();
                  handleOpenInstance(peer.id);
                }}
              >
                {opening === peer.id ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />}
                <span className="truncate">{peer.name}</span>
                <span
                  className={`ml-auto size-2 shrink-0 rounded-full ${peer.status === "online" ? "bg-status-success" : "bg-status-neutral"}`}
                  aria-hidden="true"
                />
                <span className="sr-only">{peer.status === "online" ? "Online" : "Offline"}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Admin */}
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 cursor-pointer">
              <Link href="/admin">
                <Shield className="size-4" />
                Admin
              </Link>
            </DropdownMenuItem>
          </>
        )}

        {/* Theme switcher */}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5 w-full">
            {([
              { value: "light", icon: Sun, label: "Light" },
              { value: "dark", icon: Moon, label: "Dark" },
              { value: "system", icon: Monitor, label: "Auto" },
            ] as const).map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={(e) => {
                  e.preventDefault();
                  setTheme(value);
                }}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  theme === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Sign out */}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          variant="destructive"
          onClick={handleSignOut}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A linked instance's orgs under its own heading. Picking one browses it here, read-only. */
function RemoteOrgs({ peer }: { peer: ListedInstance }) {
  const result = peer.organizations;
  if (!result) return null;
  return (
    <>
      <DropdownMenuLabel>
        <InstanceBadge name={peer.name} />
      </DropdownMenuLabel>
      {result.state === "ok" ? (
        result.data.length > 0 ? (
          result.data.map((org) => (
            <DropdownMenuItem key={org.id} asChild className="gap-2 cursor-pointer">
              <Link href={`/instances/${encodeURIComponent(peer.id)}/${encodeURIComponent(org.id)}`}>
                <Building2 className="size-4" />
                <span className="truncate">{org.name}</span>
              </Link>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No organizations there</DropdownMenuItem>
        )
      ) : (
        <DropdownMenuItem disabled title={result.state === "refused" ? result.reason : undefined}>
          <span className="truncate">{result.state === "unreachable" ? "Unreachable" : result.reason}</span>
        </DropdownMenuItem>
      )}
    </>
  );
}
