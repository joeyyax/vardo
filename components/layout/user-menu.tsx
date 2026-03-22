"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut, User, Users, ChevronsUpDown, Loader2, Settings, Shield, Building2, Check, Plus, Sun, Moon, Monitor } from "lucide-react";
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
import { getInitials } from "@/lib/utils";
import type { Organization } from "@/lib/types";

type UserMenuProps = {
  collapsed?: boolean;
  compact?: boolean;
  currentOrgId?: string;
  organizations?: Organization[];
};

export function UserMenu({ collapsed, compact, currentOrgId, organizations }: UserMenuProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { data: session, isPending } = useSession();

  const currentOrg = organizations?.find((o) => o.id === currentOrgId) || organizations?.[0];

  const handleSignOut = async () => {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login");
        },
      },
    });
  };

  const handleSwitchOrg = (orgId: string) => {
    if (orgId === currentOrg?.id) return;
    document.cookie = `time_current_org=${orgId};path=/;max-age=${60 * 60 * 24 * 365}`;
    window.location.reload();
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
    <DropdownMenu>
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
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{displayName}</p>
            <p className="text-xs text-muted-foreground">{email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          onClick={() => router.push("/user/settings/profile")}
        >
          <User className="size-4" />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          onClick={() => router.push("/admin")}
        >
          <Shield className="size-4" />
          Admin
        </DropdownMenuItem>

        {/* Org switcher */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Organizations
        </DropdownMenuLabel>
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
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          onClick={() => router.push("/org/settings")}
        >
          <Settings className="size-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          onClick={() => router.push("/org/settings/team")}
        >
          <Users className="size-4" />
          Team
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          onClick={() => router.push("/onboarding")}
        >
          <Plus className="size-4" />
          New organization
        </DropdownMenuItem>

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
