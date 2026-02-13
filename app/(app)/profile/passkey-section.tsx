"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  KeyRound,
  Plus,
  Trash2,
  Smartphone,
  Monitor,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { passkey as passkeyClient } from "@/lib/auth/client";

type Passkey = {
  id: string;
  name: string | null;
  createdAt: Date;
  deviceType: string | null;
};

export function PasskeySection() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Passkey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchPasskeys = useCallback(async () => {
    try {
      const { data } = await passkeyClient.listUserPasskeys();
      if (data) {
        setPasskeys(data as Passkey[]);
      }
    } catch {
      // Silently fail - user may not have any passkeys
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPasskeys();
  }, [fetchPasskeys]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await passkeyClient.deletePasskey({
        id: deleteTarget.id,
      });
      if (error) {
        toast.error(error.message || "Failed to delete passkey");
        return;
      }
      toast.success("Passkey deleted");
      setPasskeys((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      toast.error("Failed to delete passkey");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Passkeys</p>
          <p className="text-sm text-muted-foreground">
            Manage passkeys for passwordless sign-in.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">
              <Plus className="mr-2 size-4" />
              Add passkey
            </Button>
          </DialogTrigger>
          <DialogContent className="squircle sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add a passkey</DialogTitle>
              <DialogDescription>
                Register a new passkey for passwordless sign-in. You&apos;ll be
                prompted by your browser or device.
              </DialogDescription>
            </DialogHeader>
            <AddPasskeyForm
              onSuccess={() => {
                setAddOpen(false);
                fetchPasskeys();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Passkey list */}
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : passkeys.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <KeyRound className="mx-auto mb-2 size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No passkeys registered yet.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {passkeys.map((pk) => (
            <div
              key={pk.id}
              className="flex items-center justify-between rounded-lg border px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {pk.deviceType === "singleDevice" ? (
                  <Smartphone className="size-4 text-muted-foreground" />
                ) : (
                  <Monitor className="size-4 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">
                    {pk.name || "Scope"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Added{" "}
                    {new Date(pk.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteTarget(pk)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove &ldquo;{deleteTarget?.name || "Scope"}
              &rdquo; from your account. You won&apos;t be able to use it to
              sign in anymore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddPasskeyForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      const { error } = await passkeyClient.addPasskey({
        name: name.trim() || undefined,
      });
      if (error) {
        toast.error(error.message || "Failed to add passkey");
        return;
      }
      toast.success("Passkey added successfully");
      onSuccess();
    } catch {
      toast.error("Failed to add passkey. Make sure your browser supports passkeys.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="passkey-name">Name (optional)</Label>
        <Input
          id="passkey-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. "MacBook Pro", "iPhone"'
          disabled={adding}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          Give this passkey a name to identify it later.
        </p>
      </div>
      <Button type="submit" disabled={adding} className="w-full">
        {adding ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Registering...
          </>
        ) : (
          <>
            <KeyRound className="mr-2 size-4" />
            Register passkey
          </>
        )}
      </Button>
    </form>
  );
}
