"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Mail, MoreHorizontal, RefreshCw, XCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { isAdmin } from "@/lib/auth/permissions";
import { formatDistanceToNow } from "date-fns";

type Invitation = {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
  inviter: { id: string; name: string | null; email: string } | null;
};

type InvitationsPanelProps = {
  orgId: string;
  orgName: string;
  currentRole: string;
  invitations: Invitation[];
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
};

export function InvitationsPanel({
  orgId,
  orgName,
  currentRole,
  invitations: initialInvitations,
}: InvitationsPanelProps) {
  const router = useRouter();
  const [invitations, setInvitations] = useState(initialInvitations);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const canManage = isAdmin(currentRole);

  async function handleInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
          scope: "org",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to send invitation");
        return;
      }

      toast.success(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      router.refresh();
    } catch {
      toast.error("Failed to send invitation");
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(invitationId: string, email: string) {
    if (!confirm(`Revoke invitation for ${email}?`)) return;
    setPendingAction(invitationId);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/invitations/${invitationId}`,
        { method: "DELETE" }
      );

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to revoke invitation");
        return;
      }

      toast.success("Invitation revoked");
      setInvitations((prev) =>
        prev.map((inv) =>
          inv.id === invitationId ? { ...inv, status: "expired" as const } : inv
        )
      );
    } catch {
      toast.error("Failed to revoke invitation");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleResend(invitationId: string, email: string) {
    setPendingAction(invitationId);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/invitations/${invitationId}`,
        { method: "PATCH" }
      );

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to resend invitation");
        return;
      }

      toast.success(`Invitation resent to ${email}`);
    } catch {
      toast.error("Failed to resend invitation");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {invitations.filter((i) => i.status === "pending").length} pending
            invitation{invitations.filter((i) => i.status === "pending").length !== 1 ? "s" : ""}
          </p>
          {canManage && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Invite
            </Button>
          )}
        </div>

        {invitations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border border-dashed gap-2">
            <Mail className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No invitations yet</p>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setInviteOpen(true)}
              >
                Send your first invitation
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {invitations.map((invitation) => {
              const isPending = invitation.status === "pending";
              const isAccepted = invitation.status === "accepted";
              const isExpired = invitation.status === "expired";

              return (
                <div
                  key={invitation.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <Mail className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {invitation.inviter?.name
                          ? `Invited by ${invitation.inviter.name}`
                          : "Invited"}{" "}
                        {formatDistanceToNow(new Date(invitation.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <Badge variant="secondary">
                      {ROLE_LABELS[invitation.role] || invitation.role}
                    </Badge>

                    <Badge
                      variant={isAccepted ? "default" : isExpired ? "outline" : "secondary"}
                      className={
                        isAccepted
                          ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                          : isExpired
                          ? "text-muted-foreground"
                          : ""
                      }
                    >
                      {isAccepted && <CheckCircle2 className="mr-1 size-3" />}
                      {STATUS_LABELS[invitation.status]}
                    </Badge>

                    {canManage && isPending && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={pendingAction === invitation.id}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="gap-2 cursor-pointer"
                            onClick={() => handleResend(invitation.id, invitation.email)}
                          >
                            <RefreshCw className="size-4" />
                            Resend email
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="gap-2 cursor-pointer"
                            variant="destructive"
                            onClick={() => handleRevoke(invitation.id, invitation.email)}
                          >
                            <XCircle className="size-4" />
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Invite sheet */}
      <BottomSheet open={inviteOpen} onOpenChange={setInviteOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Invite to {orgName}</BottomSheetTitle>
            <BottomSheetDescription>
              Send an invitation email. They&apos;ll get a link to join the organization.
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
            <Button
              variant="outline"
              onClick={() => setInviteOpen(false)}
              disabled={inviting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.trim()}
            >
              {inviting ? "Sending..." : "Send invitation"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </>
  );
}
