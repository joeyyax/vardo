"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Copy,
  RefreshCw,
  Loader2,
  Send,
  Trash2,
  UserPlus,
  Mail,
} from "lucide-react";

// --- Types ---

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  inviter: {
    id: string;
    name: string;
    email: string;
  };
}

interface JoinLinkData {
  joinToken: string | null;
  joinEnabled: boolean;
}

interface TeamContentProps {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  currentUserId: string;
  currentRole: string;
}

// --- Helpers ---

function roleBadgeVariant(role: string) {
  switch (role) {
    case "owner":
      return "default" as const;
    case "admin":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString();
}

// --- Component ---

export function TeamContent({
  orgId,
  orgName,
  isAdmin,
  currentUserId,
  currentRole,
}: TeamContentProps) {
  // Members
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);

  // Invitations (admin only)
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);

  // Join link (admin only)
  const [joinLink, setJoinLink] = useState<JoinLinkData | null>(null);
  const [joinLinkLoading, setJoinLinkLoading] = useState(true);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteSending, setInviteSending] = useState(false);

  // Loading states for individual actions
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<string | null>(null);
  const [joinLinkUpdating, setJoinLinkUpdating] = useState(false);

  // --- Data fetching ---

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/members`);
      if (!res.ok) throw new Error("Failed to fetch members");
      const data = await res.json();
      setMembers(data.members);
    } catch {
      toast.error("Failed to load members");
    } finally {
      setMembersLoading(false);
    }
  }, [orgId]);

  const fetchInvitations = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/team-invitations`
      );
      if (!res.ok) throw new Error("Failed to fetch invitations");
      const data = await res.json();
      setInvitations(data.invitations);
    } catch {
      toast.error("Failed to load invitations");
    } finally {
      setInvitationsLoading(false);
    }
  }, [orgId]);

  const fetchJoinLink = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/join-link`);
      if (!res.ok) throw new Error("Failed to fetch join link");
      const data = await res.json();
      setJoinLink(data);
    } catch {
      toast.error("Failed to load join link settings");
    } finally {
      setJoinLinkLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchMembers();
    if (isAdmin) {
      fetchInvitations();
      fetchJoinLink();
    } else {
      setInvitationsLoading(false);
      setJoinLinkLoading(false);
    }
  }, [isAdmin, fetchMembers, fetchInvitations, fetchJoinLink]);

  // --- Actions ---

  async function handleRoleChange(userId: string, newRole: string) {
    setRoleUpdating(userId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/members/${userId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update role");
      }
      setMembers((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m))
      );
      toast.success("Role updated");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update role"
      );
    } finally {
      setRoleUpdating(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    setRemovingMember(userId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/members/${userId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove member");
      }
      setMembers((prev) => prev.filter((m) => m.id !== userId));
      toast.success("Member removed");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove member"
      );
    } finally {
      setRemovingMember(null);
    }
  }

  async function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setInviteSending(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/team-invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send invitation");
      }
      toast.success("Invitation sent");
      setInviteEmail("");
      setInviteRole("member");
      fetchInvitations();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to send invitation"
      );
    } finally {
      setInviteSending(false);
    }
  }

  async function handleResendInvite(invitationId: string) {
    setResendingInvite(invitationId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/team-invitations/${invitationId}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to resend invitation");
      }
      toast.success("Invitation resent");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to resend invitation"
      );
    } finally {
      setResendingInvite(null);
    }
  }

  async function handleRevokeInvite(invitationId: string) {
    setRevokingInvite(invitationId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/team-invitations/${invitationId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to revoke invitation");
      }
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      toast.success("Invitation revoked");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation"
      );
    } finally {
      setRevokingInvite(null);
    }
  }

  async function handleToggleJoinLink(enabled: boolean) {
    setJoinLinkUpdating(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/join-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update join link");
      }
      const data = await res.json();
      setJoinLink(data);
      toast.success(enabled ? "Join link enabled" : "Join link disabled");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update join link"
      );
    } finally {
      setJoinLinkUpdating(false);
    }
  }

  async function handleRegenerateJoinLink() {
    setJoinLinkUpdating(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/join-link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to regenerate link");
      }
      const data = await res.json();
      setJoinLink(data);
      toast.success("Join link regenerated");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to regenerate link"
      );
    } finally {
      setJoinLinkUpdating(false);
    }
  }

  function copyJoinLink() {
    if (!joinLink?.joinToken) return;
    const url = `${window.location.origin}/invitations/team/${joinLink.joinToken}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied");
  }

  // --- Loading skeleton ---

  if (membersLoading) {
    return (
      <Card className="squircle">
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // --- Render ---

  return (
    <div className="space-y-6">
      {/* Members */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} member{members.length !== 1 ? "s" : ""} in{" "}
            {orgName}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">
                      {member.name || member.email}
                    </p>
                    <Badge variant={roleBadgeVariant(member.role)}>
                      {member.role}
                    </Badge>
                    {member.id === currentUserId && (
                      <span className="text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {member.email} &middot; Joined {formatDate(member.joinedAt)}
                  </p>
                </div>

                {isAdmin &&
                  member.role !== "owner" &&
                  member.id !== currentUserId && (
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={member.role}
                        onValueChange={(value) =>
                          handleRoleChange(member.id, value)
                        }
                        disabled={roleUpdating === member.id}
                      >
                        <SelectTrigger className="w-28 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                        </SelectContent>
                      </Select>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            disabled={removingMember === member.id}
                          >
                            {removingMember === member.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="squircle">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove member</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove {member.name || member.email} from{" "}
                              {orgName}? They will lose access to all
                              organization data.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="squircle">
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction
                              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => handleRemoveMember(member.id)}
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Invite form (admin only) */}
      {isAdmin && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Invite team member</CardTitle>
            <CardDescription>
              Send an email invitation to join {orgName}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleSendInvite}
              className="flex items-end gap-3"
            >
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="invite-email" className="text-xs">
                  Email address
                </Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="colleague@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  className="squircle"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role" className="text-xs">
                  Role
                </Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="w-28 squircle" id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                disabled={inviteSending || !inviteEmail.trim()}
                className="squircle"
              >
                {inviteSending ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <UserPlus className="size-4 mr-2" />
                )}
                Send Invite
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Pending invitations (admin only) */}
      {isAdmin && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>
              Invitations that have been sent but not yet accepted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invitationsLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No pending invitations.
              </p>
            ) : (
              <div className="divide-y">
                {invitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-muted-foreground shrink-0" />
                        <p className="text-sm font-medium truncate">
                          {invitation.email}
                        </p>
                        <Badge variant={roleBadgeVariant(invitation.role)}>
                          {invitation.role}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground ml-6">
                        Invited by {invitation.inviter.name || invitation.inviter.email}{" "}
                        on {formatDate(invitation.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        onClick={() => handleResendInvite(invitation.id)}
                        disabled={resendingInvite === invitation.id}
                        title="Resend invitation"
                      >
                        {resendingInvite === invitation.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                      </Button>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            disabled={revokingInvite === invitation.id}
                            title="Revoke invitation"
                          >
                            {revokingInvite === invitation.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="squircle">
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Revoke invitation
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              Revoke the invitation to {invitation.email}? The
                              invitation link will no longer work.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="squircle">
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction
                              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() =>
                                handleRevokeInvite(invitation.id)
                              }
                            >
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Join link (admin only) */}
      {isAdmin && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Join link</CardTitle>
            <CardDescription>
              Anyone with this link can join {orgName} as a member.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {joinLinkLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Switch
                    id="join-link-toggle"
                    checked={joinLink?.joinEnabled ?? false}
                    onCheckedChange={handleToggleJoinLink}
                    disabled={joinLinkUpdating}
                  />
                  <Label htmlFor="join-link-toggle" className="text-sm">
                    {joinLink?.joinEnabled
                      ? "Join link is active"
                      : "Join link is disabled"}
                  </Label>
                </div>

                {joinLink?.joinEnabled && joinLink.joinToken && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`${window.location.origin}/invitations/team/${joinLink.joinToken}`}
                        className="squircle text-xs font-mono"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className="squircle shrink-0"
                        onClick={copyJoinLink}
                        title="Copy link"
                      >
                        <Copy className="size-4" />
                      </Button>
                    </div>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="squircle"
                          disabled={joinLinkUpdating}
                        >
                          {joinLinkUpdating ? (
                            <Loader2 className="size-4 animate-spin mr-2" />
                          ) : (
                            <RefreshCw className="size-4 mr-2" />
                          )}
                          Regenerate link
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="squircle">
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Regenerate join link
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            The current link will stop working. Anyone who
                            already has the link will need the new one.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="squircle">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="squircle"
                            onClick={handleRegenerateJoinLink}
                          >
                            Regenerate
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
