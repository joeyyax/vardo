"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Copy,
  Loader2,
  Mail,
  MoreVertical,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
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

type ProjectInvitationsProps = {
  orgId: string;
  projectId: string;
};

export function ProjectInvitations({ orgId, projectId }: ProjectInvitationsProps) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchInvitations = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/invitations`
      );
      if (response.ok) {
        const data = await response.json();
        setInvitations(data);
      }
    } catch (err) {
      console.error("Error fetching invitations:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  async function handleDelete(invitationId: string) {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/invitations/${invitationId}`,
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

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5" />
            Client Access
          </CardTitle>
          <CardDescription>
            Invite clients to view project progress
          </CardDescription>
        </div>
        <Button
          onClick={() => setDialogOpen(true)}
          size="sm"
          className="squircle"
        >
          <UserPlus className="size-4" />
          Invite
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : invitations.length === 0 ? (
          <div className="text-center py-8">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <UserPlus className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              No clients invited yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Invite clients to let them track project progress
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                onCopyLink={() => copyInviteLink(invitation.token)}
                onDelete={() => handleDelete(invitation.id)}
              />
            ))}
          </div>
        )}
      </CardContent>

      <InviteDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        orgId={orgId}
        projectId={projectId}
        onSuccess={fetchInvitations}
      />
    </Card>
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
        <div className="flex size-8 items-center justify-center rounded-full bg-muted shrink-0">
          <Mail className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{invitation.email}</p>
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
                  This will remove {invitation.email}'s access to this project. They
                  will no longer be able to view project progress.
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
  projectId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "contributor">("viewer");
  const [showTime, setShowTime] = useState(true);
  const [showCosts, setShowCosts] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
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
        `/api/v1/organizations/${orgId}/projects/${projectId}/invitations`,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Invite Client</DialogTitle>
            <DialogDescription>
              Invite a client to view this project's progress
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            {/* Email */}
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="client@example.com"
                required
                autoFocus
                className="squircle"
              />
            </div>

            {/* Role */}
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole(value as "viewer" | "contributor")}
              >
                <SelectTrigger id="invite-role" className="squircle">
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

            {/* Visibility settings */}
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

          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
