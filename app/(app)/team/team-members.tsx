"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, MoreHorizontal, Shield, UserMinus, Crown } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { isAdmin } from "@/lib/auth/permissions";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { getInitials } from "@/lib/utils";
import type { Organization } from "@/lib/types";

type Member = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  joinedAt: string;
};

type TeamMembersProps = {
  members: Member[];
  orgId: string;
  orgName: string;
  currentRole: string;
  currentUserId: string;
  organizations: Organization[];
  /** When true, skip the page header (used when embedded in settings) */
  embedded?: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function TeamMembers({ members: initialMembers, orgId, orgName, currentRole, currentUserId, organizations, embedded }: TeamMembersProps) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string | null } | null>(null);
  const [removing, setRemoving] = useState(false);

  const canManage = isAdmin(currentRole);

  async function handleInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to add member");
        return;
      }

      toast.success(`Added ${data.member.email || data.member.name}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      router.refresh();
    } catch {
      toast.error("Failed to add member");
    } finally {
      setInviting(false);
    }
  }

  async function handleChangeRole(userId: string, newRole: "admin" | "member") {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to update role");
        return;
      }

      toast.success(`Role updated to ${ROLE_LABELS[newRole]}`);
      setMembers((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m))
      );
    } catch {
      toast.error("Failed to update role");
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/members/${removeTarget.id}`, {
        method: "DELETE",
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to remove member");
        return;
      }

      toast.success("Member removed");
      setMembers((prev) => prev.filter((m) => m.id !== removeTarget.id));
      setRemoveTarget(null);
    } catch {
      toast.error("Failed to remove member");
    } finally {
      setRemoving(false);
    }
  }

  // Sort: owner first, then admin, then member
  const sortedMembers = [...members].sort((a, b) => {
    const order: Record<string, number> = { owner: 0, admin: 1, member: 2 };
    return (order[a.role] ?? 3) - (order[b.role] ?? 3);
  });

  return (
    <>
      <div className="space-y-6">
        {embedded ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {members.length} {members.length === 1 ? "member" : "members"}
            </p>
            {canManage && (
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <Plus className="mr-1.5 size-4" />
                Add member
              </Button>
            )}
          </div>
        ) : (
          <PageToolbar
            actions={
              canManage && (
                <Button onClick={() => setInviteOpen(true)}>
                  <Plus className="mr-1.5 size-4" />
                  Add member
                </Button>
              )
            }
          >
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
                <OrgSwitcher
                  currentOrgId={orgId}
                  organizations={organizations}
                  collapsed={false}
                />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {members.length} {members.length === 1 ? "member" : "members"}
              </p>
            </div>
          </PageToolbar>
        )}

        <div className="divide-y rounded-lg border">
          {sortedMembers.map((member) => {
            const isSelf = member.id === currentUserId;
            const isOwner = member.role === "owner";

            return (
              <div
                key={member.id}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="size-9">
                    <AvatarImage src={member.image ?? undefined} alt={member.name || member.email} />
                    <AvatarFallback className="text-xs">
                      {getInitials(member.name, member.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {member.name || member.email.split("@")[0]}
                      </p>
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">you</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Badge
                    variant={isOwner ? "default" : "secondary"}
                    className={isOwner ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}
                  >
                    {isOwner && <Crown className="mr-1 size-3" />}
                    {ROLE_LABELS[member.role] || member.role}
                  </Badge>

                  {canManage && !isOwner && !isSelf && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {member.role === "member" ? (
                          <DropdownMenuItem
                            className="gap-2 cursor-pointer"
                            onClick={() => handleChangeRole(member.id, "admin")}
                          >
                            <Shield className="size-4" />
                            Make admin
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            className="gap-2 cursor-pointer"
                            onClick={() => handleChangeRole(member.id, "member")}
                          >
                            <Shield className="size-4" />
                            Make member
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-2 cursor-pointer"
                          variant="destructive"
                          onClick={() => setRemoveTarget({ id: member.id, name: member.name })}
                        >
                          <UserMinus className="size-4" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDeleteDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="Remove member"
        description={`Remove ${removeTarget?.name || "this member"} from ${orgName}? They'll lose access immediately.`}
        confirmLabel="Remove"
        loadingLabel="Removing..."
        onConfirm={confirmRemove}
        loading={removing}
      />

      {/* Add member sheet */}
      <BottomSheet open={inviteOpen} onOpenChange={setInviteOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add team member</BottomSheetTitle>
            <BottomSheetDescription>
              Add an existing user to {orgName} by their email address.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <label htmlFor="invite-email" className="text-sm font-medium">
                  Email address
                </label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="teammate@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleInvite();
                    }
                  }}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Role</label>
                <div className="flex gap-2">
                  <Button
                    variant={inviteRole === "member" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setInviteRole("member")}
                  >
                    Member
                  </Button>
                  <Button
                    variant={inviteRole === "admin" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setInviteRole("admin")}
                  >
                    Admin
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {inviteRole === "admin"
                    ? "Admins can manage members, settings, and all projects."
                    : "Members can view and deploy projects."}
                </p>
              </div>
            </div>
          </div>
          <BottomSheetFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={inviting}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? "Adding..." : "Add member"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      <ConfirmDeleteDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="Remove member"
        description={`Remove ${removeTarget?.name || "this member"} from ${orgName}? They'll lose access immediately.`}
        confirmLabel="Remove"
        loadingLabel="Removing..."
        loading={removing}
        onConfirm={confirmRemove}
      />
    </>
  );
}
