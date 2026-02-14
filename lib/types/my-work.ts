export type WorkItemType = "task" | "invoice" | "inbox_item";

export type WorkItem = {
  type: WorkItemType;
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  priority?: string | null;
  estimateMinutes?: number | null;
  project?: {
    id: string;
    name: string;
    client?: { id: string; name: string; color: string | null };
  } | null;
};

export type ActivityItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  createdAt: string;
  project?: { id: string; name: string } | null;
  task?: { id: string; name: string } | null;
};

export type WorkloadSummary = {
  today: { minutesTracked: number; tasksCompleted: number };
  thisWeek: {
    minutesTracked: number;
    tasksCompleted: number;
    tasksRemaining: number;
  };
  upcoming: { itemsDueThisWeek: number; estimatedMinutes: number };
};

export type MyWorkData = {
  summary: WorkloadSummary;
  pastDue: WorkItem[];
  dueSoon: WorkItem[];
  needsTriage: WorkItem[];
  blocked: WorkItem[];
  myItems: WorkItem[];
  unassigned: WorkItem[];
  recentActivity: ActivityItem[];
};
