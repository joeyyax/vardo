"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Trash2,
  UserPlus,
  Shield,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Docker Prune (existing)
// ---------------------------------------------------------------------------

function DockerPrune() {
  const [pruning, setPruning] = useState(false);

  async function handleDockerPrune() {
    setPruning(true);
    try {
      const res = await fetch("/api/v1/admin/docker-prune", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Cleaned up ${data.spaceReclaimed || "unused resources"}`);
      } else {
        toast.error("Cleanup failed");
      }
    } catch {
      toast.error("Cleanup failed");
    } finally {
      setPruning(false);
    }
  }

  return (
    <div className="flex items-center justify-between rounded-lg border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Docker Cleanup</p>
        <p className="text-xs text-muted-foreground">
          Remove unused images, stopped containers, and dangling volumes.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={handleDockerPrune} disabled={pruning}>
        {pruning ? (
          <><Loader2 className="mr-1.5 size-4 animate-spin" />Cleaning...</>
        ) : (
          <><Trash2 className="mr-1.5 size-4" />Clean Up</>
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite User
// ---------------------------------------------------------------------------

type UserInfo = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  isAppAdmin: boolean | null;
  twoFactorEnabled: boolean | null;
  createdAt: string;
};

function InviteUser() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
    } catch {
      console.error("Failed to fetch users");
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setInviting(true);
    setInviteMessage(null);
    try {
      const res = await fetch("/api/v1/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setInviteMessage(data.message);
        setEmail("");
        setName("");
        fetchUsers();
        toast.success("User invited");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to invite user");
      }
    } catch {
      toast.error("Failed to invite user");
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">Users</h2>
      </div>

      {/* Invite form */}
      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">Invite User</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Create an account for a new user. Since public registration is disabled, this
          is the only way to add users.
        </p>

        <form onSubmit={handleInvite} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="invite-name">Name (optional)</Label>
              <Input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={inviting}>
            {inviting ? (
              <><Loader2 className="mr-1.5 size-4 animate-spin" />Inviting...</>
            ) : (
              <><UserPlus className="mr-1.5 size-4" />Invite</>
            )}
          </Button>
        </form>

        {inviteMessage && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
            <p className="text-sm text-green-400">{inviteMessage}</p>
          </div>
        )}
      </div>

      {/* User list */}
      {loadingUsers ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex items-center justify-between rounded-lg border bg-card p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                {u.isAppAdmin ? (
                  <ShieldCheck className="size-4 shrink-0 text-amber-500" />
                ) : (
                  <Shield className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">
                      {u.name || u.email}
                    </p>
                    {u.isAppAdmin && (
                      <Badge variant="secondary" className="text-xs">
                        Admin
                      </Badge>
                    )}
                    {u.twoFactorEnabled && (
                      <Badge variant="outline" className="text-xs">
                        2FA
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {u.email} &middot; Joined{" "}
                    {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export function AdminActions() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Maintenance</h2>
        <div className="space-y-2">
          <DockerPrune />
        </div>
      </div>

      <InviteUser />
    </div>
  );
}
