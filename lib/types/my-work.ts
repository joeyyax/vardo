export type WorkItemType =
  | "task"
  | "invoice"
  | "inbox_item"
  | "proposal"
  | "contract"
  | "expense"
  | "calendar_event";

export type WorkItem = {
  type: WorkItemType;
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  priority?: string | null;
  estimateMinutes?: number | null;
  amountCents?: number | null;
  project?: {
    id: string;
    name: string;
    client?: { id: string; name: string; color: string | null };
  } | null;
  // Calendar event fields
  startTime?: string | null;
  endTime?: string | null;
  allDay?: boolean;
  location?: string;
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
  money: {
    unbilledMinutes: number;
    outstandingInvoiceCents: number;
    pendingExpenseCents: number;
  };
};

export type MyWorkData = {
  summary: WorkloadSummary;
  overdue: WorkItem[];
  today: WorkItem[];
  thisWeek: WorkItem[];
  upcoming: WorkItem[];
  needsAttention: WorkItem[];
  recentActivity: ActivityItem[];
};
