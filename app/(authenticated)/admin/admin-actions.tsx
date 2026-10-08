"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  UserPlus,
  Shield,
  ShieldCheck,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/relative-time";
import { Card } from "@/components/ui/card";

type UserInfo = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  isAppAdmin: boolean | null;
  twoFactorEnabled: boolean | null;
  createdAt: string;
};

async function requestUsers(): Promise<UserInfo[] | null> {
  try {
    const res = await fetch("/api/v1/admin/users");
    if (!res.ok) return null;
    const data = await res.json();
    return data.users || [];
  } catch {
    console.error("Failed to fetch users");
    return null;
  }
}

export function UserManagement() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const applyUsers = useCallback((list: UserInfo[] | null) => {
    if (list) setUsers(list);
    setLoadingUsers(false);
  }, []);

  const fetchUsers = useCallback(async () => {
    applyUsers(await requestUsers());
  }, [applyUsers]);

  useEffect(() => {
    requestUsers().then(applyUsers);
  }, [applyUsers]);

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
        toast.error(data.error || "Couldn't invite user");
      }
    } catch {
      toast.error("Couldn't invite user");
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="type-h3 text-muted-foreground">Users</h2>
      </div>

      {/* Invite form */}
      <Card variant="surface" className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-muted-foreground" />
          <p className="type-h4">Invite user</p>
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
          <Card variant="success" className="p-4">
            <p className="text-sm text-status-success">{inviteMessage}</p>
          </Card>
        )}
      </Card>

      {/* User list */}
      {loadingUsers ? (
        <Card variant="inset" className="flex items-center justify-center p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </Card>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <Card variant="surface"
              key={u.id}
              className="flex items-center justify-between p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                {u.isAppAdmin ? (
                  <ShieldCheck className="size-4 shrink-0 text-foreground" />
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
                    {u.email} &middot; Joined <RelativeTime date={u.createdAt} />
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
