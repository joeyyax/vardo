"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus, Building2, Check, Loader2, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Organization } from "@/lib/types";

type OrgSwitcherProps = {
  currentOrgId?: string;
  organizations?: Organization[];
  collapsed?: boolean;
};

export function OrgSwitcher({ currentOrgId, organizations: initialOrganizations, collapsed }: OrgSwitcherProps) {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>(initialOrganizations || []);
  const [loading, setLoading] = useState(!initialOrganizations);
  const [switching, setSwitching] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);

  // Fetch organizations on mount only if not provided
  useEffect(() => {
    if (initialOrganizations) {
      setOrganizations(initialOrganizations);
      setLoading(false);
      return;
    }

    async function fetchOrgs() {
      try {
        const res = await fetch("/api/v1/organizations");
        if (res.ok) {
          const data = await res.json();
          setOrganizations(data.organizations || []);
        }
      } catch (err) {
        console.error("Failed to fetch organizations:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchOrgs();
  }, [initialOrganizations]);

  const currentOrg = organizations.find((o) => o.id === currentOrgId) || organizations[0];

  const handleSwitchOrg = async (orgId: string) => {
    if (orgId === currentOrg?.id) return;

    setSwitching(true);
    try {
      // Set the cookie via API or directly
      document.cookie = `time_current_org=${orgId};path=/;max-age=${60 * 60 * 24 * 365}`;
      // Refresh to apply the change
      router.refresh();
      window.location.reload();
    } catch (err) {
      console.error("Failed to switch org:", err);
      setSwitching(false);
    }
  };

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;

    setCreating(true);
    try {
      const res = await fetch("/api/v1/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newOrgName.trim() }),
      });

      if (res.ok) {
        const data = await res.json();
        // Switch to the new org
        document.cookie = `time_current_org=${data.organization.id};path=/;max-age=${60 * 60 * 24 * 365}`;
        setShowCreateDialog(false);
        setNewOrgName("");
        window.location.reload();
      }
    } catch (err) {
      console.error("Failed to create organization:", err);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-auto px-3 py-1.5 gap-1.5 font-medium"
            disabled={switching}
          >
            {switching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <>
                <span className="truncate text-sm">
                  {currentOrg?.name || "Select organization"}
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Organizations
          </DropdownMenuLabel>
          {organizations.map((org) => (
            <DropdownMenuItem
              key={org.id}
              className="gap-2 cursor-pointer"
              onClick={() => handleSwitchOrg(org.id)}
            >
              <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
                <Building2 className="size-3" />
              </div>
              <span className="truncate">{org.name}</span>
              {org.id === currentOrg?.id && (
                <Check className="ml-auto size-4 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 cursor-pointer"
            onClick={() => router.push("/org/settings")}
          >
            <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
              <Settings className="size-3" />
            </div>
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 cursor-pointer"
            onClick={() => router.push("/org/settings/team")}
          >
            <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
              <Users className="size-3" />
            </div>
            <span>Team</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 cursor-pointer"
            onClick={() => setShowCreateDialog(true)}
          >
            <div className="flex size-5 items-center justify-center rounded-sm border border-dashed">
              <Plus className="size-3" />
            </div>
            <span>Create organization</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BottomSheet open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Create organization</BottomSheetTitle>
            <BottomSheetDescription>
              Create a new organization to track time for a different team or client.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="org-name">Organization name</Label>
                <Input
                  id="org-name"
                  placeholder="My Company"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateOrg();
                    }
                  }}
                />
              </div>
            </div>
          </div>
          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateDialog(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateOrg} disabled={creating || !newOrgName.trim()}>
              {creating ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </>
  );
}
