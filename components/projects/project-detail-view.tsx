"use client";

import { Badge } from "@/components/ui/badge";
import { BudgetBar } from "@/components/ui/budget-bar";
import { DetailField } from "@/components/ui/detail-field";
import type { Project } from "./project-dialog";
import { PROJECT_STAGE_LABELS, PROJECT_STAGE_COLORS } from "./project-dialog";

type ProjectDetailViewProps = {
  project: Project;
  onEdit: () => void;
  budgetUsage?: {
    usedHours: number;
    usedCents: number;
  } | null;
};

export function ProjectDetailView({ project, onEdit, budgetUsage }: ProjectDetailViewProps) {
  const formatRate = (cents: number | null) => {
    if (cents === null) return null;
    return `$${(cents / 100).toFixed(2)}`;
  };

  return (
    <div className="space-y-6">
      {/* Basic info */}
      <div className="space-y-4">
        <DetailField label="Client">
          <div className="flex items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
              style={{
                backgroundColor: project.client.color || "#94a3b8",
              }}
            />
            <span className="text-sm font-medium">{project.client.name}</span>
          </div>
        </DetailField>

        <DetailField label="Project name">
          <span className="font-medium">{project.name}</span>
        </DetailField>

        {project.code && (
          <DetailField label="Project code">
            <span className="font-mono">{project.code}</span>
          </DetailField>
        )}

        <DetailField label="Stage">
          <Badge
            variant="secondary"
            className={PROJECT_STAGE_COLORS[project.stage || "getting_started"]}
          >
            {PROJECT_STAGE_LABELS[project.stage || "getting_started"]}
          </Badge>
        </DetailField>

        <DetailField label="Hourly rate">
          {formatRate(project.rateOverride) || (
            <span className="italic">Inherits from client</span>
          )}
        </DetailField>

        <DetailField label="Billable">
          {project.isBillable === null ? (
            <span className="italic">Inherits from client</span>
          ) : project.isBillable ? (
            "Yes"
          ) : (
            "No"
          )}
        </DetailField>

        {project.budgetType && (project.budgetHours || project.budgetAmountCents) && (
          <DetailField label="Budget">
            <BudgetBar
              budgetType={project.budgetType}
              budgetValue={project.budgetType === "hours"
                ? (project.budgetHours ?? 0)
                : (project.budgetAmountCents ?? 0)}
              usedValue={project.budgetType === "hours"
                ? (budgetUsage?.usedHours ?? 0)
                : (budgetUsage?.usedCents ?? 0)}
            />
          </DetailField>
        )}
      </div>

      {project.isArchived && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            This project is archived. It won&apos;t appear in time entry suggestions.
          </p>
        </div>
      )}
    </div>
  );
}
