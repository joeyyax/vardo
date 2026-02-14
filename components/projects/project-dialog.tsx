"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { ProjectDetailView } from "./project-detail-view";
import { ProjectDetailEdit } from "./project-detail-edit";
import { ProjectComments } from "./project-comments";
import { WatchButton } from "@/components/watch-button";

// Type definitions
export type Client = {
  id: string;
  name: string;
  color: string | null;
};

export type ProjectStage =
  | "getting_started"
  | "proposal"
  | "agreement"
  | "onboarding"
  | "active"
  | "ongoing"
  | "offboarding"
  | "completed";
export type BudgetType = "hours" | "fixed";

export type Project = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  stage: ProjectStage | null;
  budgetType: BudgetType | null;
  budgetHours: number | null;
  budgetAmountCents: number | null;
  assignedTo: string | null;
  intakeEmailToken: string | null;
  createdAt: string;
  updatedAt: string;
  client: Client;
};

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  getting_started: "Getting Started",
  proposal: "Proposal",
  agreement: "Agreement",
  onboarding: "Onboarding",
  active: "Active",
  ongoing: "Ongoing",
  offboarding: "Offboarding",
  completed: "Completed",
};

export const PROJECT_STAGE_COLORS: Record<ProjectStage, string> = {
  getting_started:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  proposal:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  agreement:
    "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  onboarding:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
  active:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  ongoing:
    "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  offboarding:
    "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  completed:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  orgId: string;
  clients: Client[];
  defaultClientId?: string | null;
  currentUserId?: string;
  onSuccess: () => void;
};

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  orgId,
  clients,
  defaultClientId,
  currentUserId,
  onSuccess,
}: ProjectDialogProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(!project);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [budgetUsage, setBudgetUsage] = useState<{ usedHours: number; usedCents: number } | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string | null; email: string }[]>([]);

  // Fetch org members for owner selector
  useEffect(() => {
    if (!open) return;
    async function fetchMembers() {
      try {
        const response = await fetch(`/api/v1/organizations/${orgId}/members`);
        if (response.ok) {
          const data = await response.json();
          setMembers(data.members || []);
        }
      } catch (err) {
        console.error("Error fetching members:", err);
      }
    }
    fetchMembers();
  }, [open, orgId]);

  // Reset edit mode when dialog opens
  useEffect(() => {
    if (open) {
      setIsEditing(!project);
      setError(null);
    }
  }, [open, project]);

  // Fetch budget usage when dialog opens with a budgeted project
  useEffect(() => {
    if (!open || !project || !project.budgetType) {
      setBudgetUsage(null);
      return;
    }

    async function fetchBudgetUsage() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project!.id}/stats`);
        if (res.ok) {
          const data = await res.json();
          setBudgetUsage({
            usedHours: (data.totalMinutesAllTime ?? 0) / 60,
            usedCents: data.budgetUsedAmount ?? 0,
          });
        }
      } catch (err) {
        console.error("Error fetching budget usage:", err);
      }
    }
    fetchBudgetUsage();
  }, [open, project, orgId]);

  const handleSave = useCallback((projectId?: string) => {
    if (projectId) {
      // New project — navigate to its dashboard
      onOpenChange(false);
      router.push(`/projects/${projectId}`);
    } else {
      setIsEditing(false);
      onSuccess();
    }
  }, [onSuccess, onOpenChange, router]);

  const handleCancel = useCallback(() => {
    if (project) {
      setIsEditing(false);
    } else {
      onOpenChange(false);
    }
  }, [project, onOpenChange]);

  const handleArchiveToggle = async () => {
    if (!project) return;
    setIsArchiving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !project.isArchived }),
        }
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
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
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
      setShowDeleteDialog(false);
    }
  };

  const title = project
    ? isEditing ? "Edit project" : "Project Details"
    : "New project";

  const description = project
    ? isEditing
      ? "Update project details or manage its status."
      : "View project details and discussion."
    : "Create a new project to organize your work.";

  const actions = isEditing ? (
    <>
      <Button
        variant="outline"
        onClick={handleCancel}
        size="sm"
        className="squircle"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="project-edit-form"
        size="sm"
        className="squircle"
      >
        {project ? "Save" : "Create"}
      </Button>
    </>
  ) : (
    <>
      {project && (
        <>
          <WatchButton entityType="project" entityId={project.id} orgId={orgId} projectId={project.id} />
          <IconButton
            icon={project.isArchived ? ArchiveRestore : Archive}
            tooltip={project.isArchived ? "Unarchive" : "Archive"}
            onClick={handleArchiveToggle}
            loading={isArchiving}
          />
          <IconButton
            icon={Trash2}
            tooltip="Delete"
            onClick={() => setShowDeleteDialog(true)}
            loading={isDeleting}
          />
        </>
      )}
      <IconButton
        icon={Pencil}
        tooltip="Edit"
        onClick={() => setIsEditing(true)}
      />
    </>
  );

  return (
    <>
      <DetailModal
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        actions={actions}
        sidebar={
          project && currentUserId ? (
            <ProjectComments
              orgId={orgId}
              projectId={project.id}
              currentUserId={currentUserId}
              onUpdate={onSuccess}
            />
          ) : undefined
        }
      >
        {project && !isEditing ? (
          <ProjectDetailView project={project} onEdit={() => setIsEditing(true)} budgetUsage={budgetUsage} members={members} />
        ) : (
          <ProjectDetailEdit
            project={project || null}
            orgId={orgId}
            clients={clients}
            defaultClientId={defaultClientId}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </DetailModal>

      <ConfirmDeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete project?"
        description={`This will permanently delete "${project?.name}" and all associated tasks and time entries. This action cannot be undone.`}
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </>
  );
}
