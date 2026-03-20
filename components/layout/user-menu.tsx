"use client";

import { useRouter } from "next/navigation";
import { LogOut, User, ChevronsUpDown, Loader2 } from "lucide-react";
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

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

type UserMenuProps = {
  collapsed?: boolean;
  compact?: boolean;
};

export function UserMenu({ collapsed, compact }: UserMenuProps) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const handleSignOut = async () => {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login");
        },
      },
    });
  };

  if (isPending) {
    return (
      <Button
        variant="ghost"
        className={`w-full px-2 py-1.5 h-auto ${collapsed ? "justify-center" : "justify-start gap-2"}`}
        disabled
      >
        <Loader2 className="size-6 animate-spin" />
        {!collapsed && <span className="text-sm text-muted-foreground">Loading...</span>}
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
          className={`w-full px-2 py-1.5 h-auto ${collapsed ? "justify-center" : "justify-start gap-2"}`}
        >
          <Avatar className="size-6">
            <AvatarImage src={user?.image ?? undefined} alt={displayName} />
            <AvatarFallback className="text-xs bg-sidebar-accent">
              {getInitials(displayName)}
            </AvatarFallback>
          </Avatar>
          {!collapsed && !compact && (
            <>
              <div className="flex flex-1 flex-col items-start gap-0 overflow-hidden">
                <span className="truncate text-sm font-medium">{displayName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {email}
                </span>
              </div>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
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
          onClick={() => router.push("/profile")}
        >
          <User className="size-4" />
          <span>Profile</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 cursor-pointer"
          variant="destructive"
          onClick={handleSignOut}
        >
          <LogOut className="size-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
