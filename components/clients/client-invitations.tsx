"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Copy,
  Loader2,
  Mail,
  MoreVertical,
  Trash2,
  UserPlus,
  Check,
  Clock,
  Eye,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

type Invitation = {
  id: string;
  email: string;
  role: "viewer" | "contributor";
  visibility: {
    show_rates: boolean;
    show_time: boolean;
    show_costs: boolean;
  };
  token: string;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  userId: string | null;
  createdAt: string;
};

type ClientInvitationsProps = {
  orgId: string;
  clientId: string;
};

const MAX_VISIBLE_AVATARS = 3;

function getInitials(email: string): string {
  const local = email.split("@")[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function ClientInvitations({ orgId, clientId }: ClientInvitationsProps) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const fetchInvitations = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientId}/invitations`
      );
      if (response.ok) {
        const data = await response.json();
        setInvitations(data);
      }
    } catch (err) {
      console.error("Error fetching client invitations:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, clientId]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  async function handleDelete(invitationId: string) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientId}/invitations/${invitationId}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        toast.success("Invitation revoked");
        fetchInvitations();
      } else {
        toast.error("Failed to revoke invitation");
      }
    } catch {
      toast.error("Failed to revoke invitation");
    }
  }

  function copyInviteLink(token: string) {
    const url = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(url);
    toast.success("Invite link copied to clipboard");
  }

  const visibleInvitations = invitations.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = Math.max(0, invitations.length - MAX_VISIBLE_AVATARS);

  return (
    <>
      {/* Avatar stack trigger */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="flex items-center gap-1 rounded-full transition-opacity hover:opacity-80"
            >
              {isLoading ? (
                <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                </div>
              ) : invitations.length === 0 ? (
                <div className="flex size-8 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground transition-colors">
                  <UserPlus className="size-3.5" />
                </div>
              ) : (
                <AvatarGroup>
                  {visibleInvitations.map((inv) => (
                    <Avatar key={inv.id} size="sm">
                      <AvatarFallback className="text-[10px] font-medium">
                        {getInitials(inv.email)}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                  {overflowCount > 0 && (
                    <AvatarGroupCount className="text-[10px]">
                      +{overflowCount}
                    </AvatarGroupCount>
                  )}
                </AvatarGroup>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {invitations.length === 0
              ? "Invite clients"
              : `${invitations.length} client${invitations.length !== 1 ? "s" : ""} invited`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Management dialog */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Client Access</DialogTitle>
            <DialogDescription>
              Manage who can view this client and all its projects
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {invitations.length === 0 ? (
              <div className="text-center py-8">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
                  <UserPlus className="size-5 text-muted-foreground" />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  No clients invited yet
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Client-level access applies to all projects
                </p>
              </div>
            ) : (
              invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  onCopyLink={() => copyInviteLink(invitation.token)}
                  onDelete={() => handleDelete(invitation.id)}
                />
              ))
            )}
          </div>

          <div className="pt-2">
            <Button
              onClick={() => setInviteOpen(true)}
              className="squircle w-full"
              variant="outline"
            >
              <UserPlus className="size-4" />
              Invite Client
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Invite form bottom sheet */}
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        orgId={orgId}
        clientId={clientId}
        onSuccess={fetchInvitations}
      />
    </>
  );
}

function InvitationRow({
  invitation,
  onCopyLink,
  onDelete,
}: {
  invitation: Invitation;
  onCopyLink: () => void;
  onDelete: () => void;
}) {
  const status = invitation.acceptedAt
    ? "accepted"
    : invitation.viewedAt
    ? "viewed"
    : invitation.sentAt
    ? "pending"
    : "draft";

  const statusConfig = {
    accepted: {
      label: "Accepted",
      color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
      icon: Check,
    },
    viewed: {
      label: "Viewed",
      color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
      icon: Eye,
    },
    pending: {
      label: "Pending",
      color: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
      icon: Clock,
    },
    draft: {
      label: "Not sent",
      color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      icon: Mail,
    },
  };

  const StatusIcon = statusConfig[status].icon;

  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
      <div className="flex items-center gap-3 min-w-0">
        <Avatar size="sm">
          <AvatarFallback className="text-[10px] font-medium">
            {getInitials(invitation.email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{invitation.email}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="squircle capitalize text-xs py-0">
              {invitation.role}
            </Badge>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${statusConfig[status].color}`}>
              <StatusIcon className="size-3" />
              {statusConfig[status].label}
            </span>
          </div>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="squircle shrink-0">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="squircle">
          <DropdownMenuItem onClick={onCopyLink}>
            <Copy className="size-4" />
            Copy invite link
          </DropdownMenuItem>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <DropdownMenuItem
                onSelect={(e) => e.preventDefault()}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" />
                Revoke access
              </DropdownMenuItem>
            </AlertDialogTrigger>
            <AlertDialogContent className="squircle">
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke access?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove {invitation.email}&apos;s access to this client
                  and all its projects.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Revoke
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  orgId,
  clientId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  clientId: string;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "contributor">("viewer");
  const [showTime, setShowTime] = useState(true);
  const [showCosts, setShowCosts] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("viewer");
      setShowTime(true);
      setShowCosts(false);
      setShowRates(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientId}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            role,
            visibility: {
              show_time: showTime,
              show_costs: showCosts,
              show_rates: showRates,
            },
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create invitation");
      }

      toast.success("Invitation created", {
        description: `Invite link ready for ${email}`,
      });
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent className="squircle">
        <form onSubmit={handleSubmit}>
          <BottomSheetHeader>
            <BottomSheetTitle>Invite Client</BottomSheetTitle>
            <BottomSheetDescription>
              This person will have access to all projects under this client
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-5 py-6">
            <div className="grid gap-2">
              <Label htmlFor="client-invite-email">Email address</Label>
              <Input
                id="client-invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="client@example.com"
                required
                autoFocus
                className="squircle"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="client-invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole(value as "viewer" | "contributor")}
              >
                <SelectTrigger id="client-invite-role" className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="viewer">
                    <div className="flex flex-col items-start">
                      <span>Viewer</span>
                      <span className="text-xs text-muted-foreground">
                        Can view tasks and progress
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="contributor">
                    <div className="flex flex-col items-start">
                      <span>Contributor</span>
                      <span className="text-xs text-muted-foreground">
                        Can create and manage tasks
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4">
              <Label>What can they see?</Label>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Time tracked</p>
                  <p className="text-xs text-muted-foreground">
                    Show total hours logged
                  </p>
                </div>
                <Switch
                  checked={showTime}
                  onCheckedChange={setShowTime}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Project costs</p>
                  <p className="text-xs text-muted-foreground">
                    Show billable amounts
                  </p>
                </div>
                <Switch
                  checked={showCosts}
                  onCheckedChange={setShowCosts}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Hourly rates</p>
                  <p className="text-xs text-muted-foreground">
                    Show rate information
                  </p>
                </div>
                <Switch
                  checked={showRates}
                  onCheckedChange={setShowRates}
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          </div>

          <BottomSheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !email.trim()}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              Create Invitation
            </Button>
          </BottomSheetFooter>
        </form>
      </BottomSheetContent>
    </BottomSheet>
  );
}
