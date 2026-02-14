"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Avatar,
  AvatarBadge,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Check,
  Clock,
  Copy,
  Eye,
  Loader2,
  Mail,
  MoreVertical,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

type Member = {
  id: string;
  name: string;
  email: string;
  assignedAt: string;
};

type OrgMember = {
  id: string;
  name: string;
  email: string;
  role: string;
};

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

type ProjectPeopleProps = {
  orgId: string;
  projectId: string;
  isAdmin: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_VISIBLE_AVATARS = 4;

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  const local = email.split("@")[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

const INVITATION_STATUS_CONFIG = {
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
} as const;

function getInvitationStatus(inv: Invitation) {
  if (inv.acceptedAt) return "accepted";
  if (inv.viewedAt) return "viewed";
  if (inv.sentAt) return "pending";
  return "draft";
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ProjectPeople({ orgId, projectId, isAdmin }: ProjectPeopleProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/members`
      );
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members);
      }
    } catch (err) {
      console.error("Error fetching project members:", err);
    }
  }, [orgId, projectId]);

  const fetchInvitations = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/invitations`
      );
      if (res.ok) {
        const data = await res.json();
        setInvitations(data);
      }
    } catch (err) {
      console.error("Error fetching invitations:", err);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    Promise.all([fetchMembers(), fetchInvitations()]).finally(() =>
      setIsLoading(false)
    );
  }, [fetchMembers, fetchInvitations]);

  // Fetch org members for add selector (admin only, when popover is open)
  useEffect(() => {
    if (!isAdmin || !popoverOpen) return;
    async function fetchOrgMembers() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/members`);
        if (res.ok) {
          const data = await res.json();
          setOrgMembers(data.members);
        }
      } catch (err) {
        console.error("Error fetching org members:", err);
      }
    }
    fetchOrgMembers();
  }, [isAdmin, orgId, popoverOpen]);

  // Reset add member view when popover closes
  useEffect(() => {
    if (!popoverOpen) setShowAddMember(false);
  }, [popoverOpen]);

  async function handleAddMember(userId: string) {
    const res = await fetch(
      `/api/v1/organizations/${orgId}/projects/${projectId}/members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      }
    );
    if (res.ok) {
      toast.success("Member added to project");
      fetchMembers();
      setShowAddMember(false);
    } else {
      const data = await res.json();
      toast.error(data.error || "Failed to add member");
    }
  }

  async function handleRemoveMember(userId: string) {
    const res = await fetch(
      `/api/v1/organizations/${orgId}/projects/${projectId}/members?userId=${userId}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      toast.success("Member removed from project");
      fetchMembers();
    } else {
      toast.error("Failed to remove member");
    }
  }

  async function handleDeleteInvitation(invitationId: string) {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/invitations/${invitationId}`,
        { method: "DELETE" }
      );
      if (res.ok) {
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

  // Combined avatar stack
  const totalPeople = members.length + invitations.length;
  const allAvatars: { key: string; initials: string; isExternal: boolean }[] = [
    ...members.map((m) => ({
      key: `m-${m.id}`,
      initials: getInitials(m.name, m.email),
      isExternal: false,
    })),
    ...invitations.map((inv) => ({
      key: `i-${inv.id}`,
      initials: getInitials(null, inv.email),
      isExternal: true,
    })),
  ];
  const visibleAvatars = allAvatars.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = Math.max(0, allAvatars.length - MAX_VISIBLE_AVATARS);

  const availableOrgMembers = orgMembers
    .filter((m) => !members.some((pm) => pm.id === m.id))
    .filter((m) => m.role === "member");

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-full transition-opacity hover:opacity-80"
                >
                  {isLoading ? (
                    <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                      <Loader2 className="size-3 animate-spin text-muted-foreground" />
                    </div>
                  ) : totalPeople === 0 ? (
                    <div className="flex size-8 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground transition-colors">
                      <Users className="size-3.5" />
                    </div>
                  ) : (
                    <AvatarGroup>
                      {visibleAvatars.map((a) => (
                        <Avatar key={a.key} size="sm">
                          <AvatarFallback className="text-[10px] font-medium">
                            {a.initials}
                          </AvatarFallback>
                          {a.isExternal && (
                            <AvatarBadge className="bg-amber-500" />
                          )}
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
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {totalPeople === 0
                ? "Manage people"
                : `${totalPeople} ${totalPeople === 1 ? "person" : "people"}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <PopoverContent align="end" className="w-80 p-0 squircle">
          <Tabs defaultValue="team" className="gap-0">
            <div className="px-4 pt-4 pb-3">
              <p className="text-sm font-medium">People</p>
              <p className="text-xs text-muted-foreground">
                Manage team members and client access
              </p>
            </div>

            <div className="px-4 pb-3">
              <TabsList className="w-full">
                <TabsTrigger value="team" className="flex-1">
                  Team
                  {members.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">
                      {members.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="clients" className="flex-1">
                  Clients
                  {invitations.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">
                      {invitations.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Team Members */}
            <TabsContent value="team" className="px-4 pb-4">
              {showAddMember ? (
                <Command className="border rounded-lg squircle">
                  <CommandInput placeholder="Search members..." autoFocus />
                  <CommandList>
                    <CommandEmpty>No available members</CommandEmpty>
                    <CommandGroup>
                      {availableOrgMembers.map((m) => (
                        <CommandItem
                          key={m.id}
                          onSelect={() => handleAddMember(m.id)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar size="sm">
                              <AvatarFallback className="text-[10px] font-medium">
                                {getInitials(m.name, m.email)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm truncate">{m.name || m.email}</p>
                              {m.name && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {m.email}
                                </p>
                              )}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              ) : (
                <div className="space-y-2">
                  {members.length === 0 ? (
                    <div className="text-center py-6">
                      <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-muted">
                        <Users className="size-4 text-muted-foreground" />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        No members assigned
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {members.map((member) => (
                        <div
                          key={member.id}
                          className="flex items-center justify-between gap-2 p-2 rounded-md hover:bg-accent/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar size="sm">
                              <AvatarFallback className="text-[10px] font-medium">
                                {getInitials(member.name, member.email)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {member.name || member.email}
                              </p>
                              {member.name && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {member.email}
                                </p>
                              )}
                            </div>
                          </div>

                          {isAdmin && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="squircle shrink-0 size-7">
                                  <MoreVertical className="size-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="squircle">
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <DropdownMenuItem
                                      onSelect={(e) => e.preventDefault()}
                                      className="text-destructive focus:text-destructive"
                                    >
                                      <Trash2 className="size-4" />
                                      Remove from project
                                    </DropdownMenuItem>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent className="squircle">
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Remove member?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This will remove {member.name || member.email}&apos;s
                                        access to this project.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => handleRemoveMember(member.id)}
                                        className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                      >
                                        Remove
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {isAdmin && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="squircle w-full"
                        onClick={() => setShowAddMember(true)}
                      >
                        <UserPlus className="size-3.5" />
                        Add Member
                      </Button>
                      <p className="text-[11px] text-muted-foreground text-center">
                        Admins and owners have access automatically.
                      </p>
                    </>
                  )}
                </div>
              )}
            </TabsContent>

            {/* Client Invitations */}
            <TabsContent value="clients" className="px-4 pb-4">
              <div className="space-y-2">
                {invitations.length === 0 ? (
                  <div className="text-center py-6">
                    <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-muted">
                      <UserPlus className="size-4 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      No clients invited yet
                    </p>
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {invitations.map((invitation) => {
                      const status = getInvitationStatus(invitation);
                      const config = INVITATION_STATUS_CONFIG[status];
                      const StatusIcon = config.icon;

                      return (
                        <div
                          key={invitation.id}
                          className="flex items-center justify-between gap-2 p-2 rounded-md hover:bg-accent/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar size="sm">
                              <AvatarFallback className="text-[10px] font-medium">
                                {getInitials(null, invitation.email)}
                              </AvatarFallback>
                              <AvatarBadge className="bg-amber-500" />
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {invitation.email}
                              </p>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Badge
                                  variant="outline"
                                  className="squircle capitalize text-[10px] px-1 py-0"
                                >
                                  {invitation.role}
                                </Badge>
                                <span
                                  className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[10px] ${config.color}`}
                                >
                                  <StatusIcon className="size-2.5" />
                                  {config.label}
                                </span>
                              </div>
                            </div>
                          </div>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="squircle shrink-0 size-7">
                                <MoreVertical className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="squircle">
                              <DropdownMenuItem
                                onClick={() => copyInviteLink(invitation.token)}
                              >
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
                                      This will remove {invitation.email}&apos;s access to
                                      this project.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel className="squircle">
                                      Cancel
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => handleDeleteInvitation(invitation.id)}
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
                    })}
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="squircle w-full"
                  onClick={() => {
                    setPopoverOpen(false);
                    setInviteOpen(true);
                  }}
                >
                  <UserPlus className="size-3.5" />
                  Invite Client
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </PopoverContent>
      </Popover>

      {/* Invite client bottom sheet (opens outside popover) */}
      <InviteClientSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        orgId={orgId}
        projectId={projectId}
        onSuccess={fetchInvitations}
      />
    </>
  );
}

// ─── Invite Client Sheet ─────────────────────────────────────────────────────

function InviteClientSheet({
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
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent className="squircle">
        <form onSubmit={handleSubmit}>
          <BottomSheetHeader>
            <BottomSheetTitle>Invite Client</BottomSheetTitle>
            <BottomSheetDescription>
              Invite a client to view this project&apos;s progress
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-6">
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

              <div className="grid gap-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(value) =>
                    setRole(value as "viewer" | "contributor")
                  }
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

              <div className="space-y-4">
                <Label>What can they see?</Label>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Time tracked</p>
                    <p className="text-xs text-muted-foreground">
                      Show total hours logged
                    </p>
                  </div>
                  <Switch checked={showTime} onCheckedChange={setShowTime} />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Project costs</p>
                    <p className="text-xs text-muted-foreground">
                      Show billable amounts
                    </p>
                  </div>
                  <Switch checked={showCosts} onCheckedChange={setShowCosts} />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Hourly rates</p>
                    <p className="text-xs text-muted-foreground">
                      Show rate information
                    </p>
                  </div>
                  <Switch checked={showRates} onCheckedChange={setShowRates} />
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
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
