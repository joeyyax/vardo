import { FolderOpen, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHoursHuman as formatDuration } from "@/lib/formatting";

type BudgetStatus = "on_budget" | "at_risk" | "over_budget";

type ProjectWithBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  budgetType: string;
  budgetValue: number;
  usedValue: number;
  usedPercentage: number;
  status: BudgetStatus;
};

type ProjectWithoutBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  totalMinutes: number;
};

type ProjectHealthProps = {
  activeCount: number;
  onBudgetCount: number;
  atRiskCount: number;
  overBudgetCount: number;
  projectsWithBudgets: ProjectWithBudget[];
  projectsWithoutBudgets: ProjectWithoutBudget[];
};

function StatCard({
  icon: Icon,
  label,
  value,
  iconClassName,
  valueClassName,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  iconClassName?: string;
  valueClassName?: string;
}) {
  return (
    <Card className="squircle">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2">
            <Icon className={`size-5 ${iconClassName ?? "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className={`text-2xl font-semibold ${valueClassName ?? ""}`}>
              {value}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getStatusColor(status: BudgetStatus): string {
  switch (status) {
    case "on_budget":
      return "bg-green-500";
    case "at_risk":
      return "bg-yellow-500";
    case "over_budget":
      return "bg-red-500";
  }
}

function getStatusLabel(status: BudgetStatus): string {
  switch (status) {
    case "on_budget":
      return "On Budget";
    case "at_risk":
      return "At Risk";
    case "over_budget":
      return "Over Budget";
  }
}

function BudgetProgressBar({
  project,
}: {
  project: ProjectWithBudget;
}) {
  const percentage = Math.min(project.usedPercentage, 100);
  const overflowPercentage = Math.max(project.usedPercentage - 100, 0);
  const colorClass = getStatusColor(project.status);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {project.clientColor && (
            <div
              className="size-2.5 rounded-full shrink-0"
              style={{ backgroundColor: project.clientColor }}
            />
          )}
          <span className="font-medium truncate">{project.name}</span>
        </div>
        <span className="text-sm text-muted-foreground shrink-0 ml-2">
          {getStatusLabel(project.status)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${colorClass}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <span className="text-sm font-medium w-12 text-right">
          {Math.round(project.usedPercentage)}%
        </span>
      </div>
      {overflowPercentage > 0 && (
        <p className="text-xs text-red-600">
          {Math.round(overflowPercentage)}% over budget
        </p>
      )}
      <p className="text-xs text-muted-foreground">{project.clientName}</p>
    </div>
  );
}

export function ProjectHealth({
  activeCount,
  onBudgetCount,
  atRiskCount,
  overBudgetCount,
  projectsWithBudgets,
  projectsWithoutBudgets,
}: ProjectHealthProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Project Health</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FolderOpen}
          label="Active Projects"
          value={activeCount}
        />
        <StatCard
          icon={CheckCircle}
          label="On Budget"
          value={onBudgetCount}
          iconClassName="text-green-600"
          valueClassName="text-green-600"
        />
        <StatCard
          icon={AlertTriangle}
          label="At Risk"
          value={atRiskCount}
          iconClassName="text-yellow-600"
          valueClassName="text-yellow-600"
        />
        <StatCard
          icon={XCircle}
          label="Over Budget"
          value={overBudgetCount}
          iconClassName="text-red-600"
          valueClassName="text-red-600"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Budget Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {projectsWithBudgets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No projects with budgets
              </p>
            ) : (
              projectsWithBudgets.map((project) => (
                <BudgetProgressBar key={project.id} project={project} />
              ))
            )}
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Projects Without Budgets</CardTitle>
          </CardHeader>
          <CardContent>
            {projectsWithoutBudgets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                All projects have budgets
              </p>
            ) : (
              <div className="space-y-3">
                {projectsWithoutBudgets.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {project.clientColor && (
                        <div
                          className="size-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: project.clientColor }}
                        />
                      )}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{project.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {project.clientName}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm text-muted-foreground shrink-0 ml-4">
                      {formatDuration(project.totalMinutes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
