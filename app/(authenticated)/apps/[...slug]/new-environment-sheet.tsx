"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BranchSelect } from "@/components/branch-select";
import type { App } from "./types";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function NewEnvironmentSheet({
  open,
  onOpenChange,
  app,
  orgId,
  productionEnvId,
  /** Environment id to preselect as the clone source, or "__production". */
  defaultCloneFrom,
  onSelectEnv,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: App;
  orgId: string;
  productionEnvId: string | undefined;
  defaultCloneFrom: string;
  onSelectEnv: (envId: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [cloneFrom, setCloneFrom] = useState(defaultCloneFrom);
  const [saving, setSaving] = useState(false);

  // Reset form each time the sheet opens
  useEffect(() => {
    if (open) {
      setName("");
      setBranch("");
      setCloneFrom(defaultCloneFrom);
    }
  }, [open, defaultCloneFrom]);

  async function handleCreate() {
    const envName = slugify(name.trim());
    if (!envName) return;
    setSaving(true);
    try {
      const cloneSource = cloneFrom === "__none" ? undefined
        : cloneFrom === "__production" ? productionEnvId
        : cloneFrom;
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: envName,
            type: "staging",
            cloneFrom: cloneSource,
            gitBranch: branch.trim() || undefined,
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const newEnvId = data.environment.id;
        onSelectEnv(newEnvId);
        onOpenChange(false);
        router.refresh();

        // Auto-deploy the new environment
        toast.success(`Environment "${envName}" created — deploying...`);
        fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/deploy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: newEnvId }),
        }).catch(() => {
          toast.error("Auto-deploy failed");
        });
      } else {
        const data = await res.json();
        if (data.error?.includes("already exists")) {
          const existing = app.environments.find((e) => e.name === envName);
          if (existing) onSelectEnv(existing.id);
          onOpenChange(false);
          toast.info("Environment already exists");
        } else {
          toast.error(data.error || "Failed to create environment");
        }
      }
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent>
        <BottomSheetHeader>
          <BottomSheetTitle>New environment</BottomSheetTitle>
          <BottomSheetDescription>
            Create a new environment from a branch. Variables are cloned from the source environment.
          </BottomSheetDescription>
        </BottomSheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid gap-5 py-4">
            {/* Branch + Name */}
            <div className="grid gap-4 sm:grid-cols-2">
              {app.source === "git" ? (
                <div className="grid gap-2">
                  <Label>Branch</Label>
                  <BranchSelect
                    value={branch}
                    onChange={(v) => {
                      setBranch(v);
                      if (!name || name === slugify(branch)) {
                        setName(slugify(v));
                      }
                    }}
                    appId={app.id}
                    orgId={orgId}
                    excludeBranch={app.gitBranch || "main"}
                  />
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label>Name</Label>
                  <Input
                    placeholder="e.g. staging, qa, demo"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              )}
              <div className="grid gap-2">
                <Label>Environment name</Label>
                <Input
                  placeholder={app.source === "git" ? "Auto-generated from branch" : "e.g. staging, qa"}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            {/* Clone source */}
            <div className="grid gap-2 sm:w-1/2">
              <Label>Clone variables from</Label>
              <Select value={cloneFrom} onValueChange={setCloneFrom}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__production">Production</SelectItem>
                  {app.environments
                    .filter((e) => e.type !== "production")
                    .map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  <SelectItem value="__none">Empty (no variables)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <BottomSheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || saving || (app.source === "git" && !branch.trim())}
          >
            {saving ? (
              <><Loader2 className="mr-2 size-4 animate-spin" />Creating...</>
            ) : (
              "Create & Deploy"
            )}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}
