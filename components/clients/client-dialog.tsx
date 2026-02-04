"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";

// Preset colors for client identification
const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
  "#64748b", // slate
];

export type Client = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  createdAt: string;
  updatedAt: string;
};

type ClientDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  orgId: string;
  onSuccess: () => void;
};

export function ClientDialog({
  open,
  onOpenChange,
  client,
  orgId,
  onSuccess,
}: ClientDialogProps) {
  const isEditing = !!client;

  // Form state
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [rateOverride, setRateOverride] = useState("");
  const [isBillable, setIsBillable] = useState<boolean | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/closes or client changes
  useEffect(() => {
    if (open) {
      if (client) {
        setName(client.name);
        setColor(client.color);
        // Convert cents to dollars for display
        setRateOverride(
          client.rateOverride !== null
            ? (client.rateOverride / 100).toString()
            : ""
        );
        setIsBillable(client.isBillable);
      } else {
        setName("");
        setColor(null);
        setRateOverride("");
        setIsBillable(null);
      }
      setError(null);
    }
  }, [open, client]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        name,
        color,
        rateOverride: rateOverride !== "" ? parseFloat(rateOverride) : null,
        isBillable,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/clients/${client.id}`
        : `/api/v1/organizations/${orgId}/clients`;

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!client) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${client.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit client" : "New client"}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update your client's details."
                : "Add a new client to your organization."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            {/* Name */}
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corp"
                required
                autoFocus
                className="squircle"
              />
            </div>

            {/* Color picker */}
            <div className="grid gap-2">
              <Label>Color</Label>
              <p className="text-sm text-muted-foreground">
                Choose a color to help identify this client.
              </p>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(color === c ? null : c)}
                    className={`size-8 rounded-full transition-all hover:scale-110 ${
                      color === c
                        ? "ring-2 ring-offset-2 ring-ring"
                        : "ring-1 ring-border"
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>

            {/* Hourly rate override */}
            <div className="grid gap-2">
              <Label htmlFor="rate">Hourly rate override</Label>
              <p className="text-sm text-muted-foreground">
                Leave blank to use your organization&apos;s default rate.
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  placeholder="0.00"
                  className="squircle pl-7"
                />
              </div>
            </div>

            {/* Billable toggle */}
            <div className="flex items-start gap-3">
              <Checkbox
                id="billable"
                checked={isBillable === true}
                onCheckedChange={(checked) => {
                  // null means inherit, true/false means explicit
                  if (checked === "indeterminate") {
                    return;
                  }
                  if (checked) {
                    setIsBillable(true);
                  } else if (isBillable === true) {
                    // Was checked, now unchecking -> set to explicit false
                    setIsBillable(false);
                  } else {
                    // Was false or null, now unchecking -> reset to null (inherit)
                    setIsBillable(null);
                  }
                }}
                className="mt-0.5"
              />
              <div className="grid gap-1">
                <Label htmlFor="billable" className="cursor-pointer">
                  Billable
                </Label>
                <p className="text-sm text-muted-foreground">
                  {isBillable === null
                    ? "Inherits from organization settings."
                    : isBillable
                    ? "Time tracked for this client is billable."
                    : "Time tracked for this client is not billable."}
                </p>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            {isEditing && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={isLoading || isDeleting}
                    className="squircle mr-auto"
                  >
                    {isDeleting && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="squircle">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete client?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete &quot;{client?.name}&quot; and all
                      associated projects and time entries. This action cannot
                      be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading || isDeleting}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || isDeleting || !name.trim()}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isEditing ? "Save changes" : "Create client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
