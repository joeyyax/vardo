"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";

type DangerZoneProps = {
  orgId: string;
  orgName: string;
};

type DeleteResult = {
  timeEntries: number;
  invoices: number;
  reportConfigs: number;
  clients: number;
};

export function DangerZone({ orgId, orgName }: DangerZoneProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);

  const isConfirmed = confirmText === orgName;

  const handleClear = async () => {
    if (!isConfirmed) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/content`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirmText }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to clear content");
      }

      setResult(data.deleted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear content");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setConfirmText("");
    setError(null);
    if (result) {
      // Reload page to reflect changes
      window.location.reload();
    }
  };

  return (
    <div className="rounded-lg border border-destructive/50 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-destructive shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h3 className="font-medium text-destructive">Danger Zone</h3>
          <p className="text-sm text-muted-foreground">
            Irreversible actions that affect all organization data.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between p-3 rounded-lg bg-destructive/5 border border-destructive/20">
        <div>
          <p className="text-sm font-medium">Clear all content</p>
          <p className="text-xs text-muted-foreground">
            Delete all time entries, invoices, clients, projects, and tasks.
            Settings and team members are preserved.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          className="squircle"
          onClick={() => setIsOpen(true)}
        >
          <Trash2 className="size-4" />
          Clear Content
        </Button>
        <BottomSheet open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheetContent className="squircle">
            <BottomSheetHeader>
              <BottomSheetTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-destructive" />
                Clear Organization Content
              </BottomSheetTitle>
              <BottomSheetDescription>
                This will permanently delete all content in this organization.
                This action cannot be undone.
              </BottomSheetDescription>
            </BottomSheetHeader>

            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {result ? (
                <div className="space-y-4">
                  <div className="rounded-lg border p-4 space-y-2">
                    <p className="font-medium text-sm">Content cleared:</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-muted-foreground">Time entries</span>
                      <span className="font-medium">{result.timeEntries}</span>
                      <span className="text-muted-foreground">Invoices</span>
                      <span className="font-medium">{result.invoices}</span>
                      <span className="text-muted-foreground">Report configs</span>
                      <span className="font-medium">{result.reportConfigs}</span>
                      <span className="text-muted-foreground">Clients (+ projects, tasks)</span>
                      <span className="font-medium">{result.clients}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border p-4 space-y-2 text-sm">
                    <p className="font-medium">The following will be deleted:</p>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1">
                      <li>All time entries</li>
                      <li>All invoices and line items</li>
                      <li>All report configurations</li>
                      <li>All clients, projects, and tasks</li>
                    </ul>
                    <p className="pt-2 font-medium">The following will be kept:</p>
                    <ul className="list-disc list-inside text-muted-foreground space-y-1">
                      <li>Organization settings</li>
                      <li>Team members and roles</li>
                      <li>Integration settings (Toggl token, etc.)</li>
                    </ul>
                  </div>

                  {error && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="confirm">
                      Type <span className="font-mono font-bold">{orgName}</span> to
                      confirm
                    </Label>
                    <Input
                      id="confirm"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={orgName}
                      className="squircle"
                      autoComplete="off"
                    />
                  </div>
                </div>
              )}
            </div>

            <BottomSheetFooter>
              {result ? (
                <Button onClick={handleClose} className="squircle">
                  Done
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={handleClose}
                    className="squircle"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleClear}
                    disabled={!isConfirmed || isDeleting}
                    className="squircle"
                  >
                    {isDeleting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    Clear All Content
                  </Button>
                </>
              )}
            </BottomSheetFooter>
          </BottomSheetContent>
        </BottomSheet>
      </div>
    </div>
  );
}
