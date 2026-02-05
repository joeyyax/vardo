export type Expense = {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category: string | null;
  vendor?: string | null;
  status?: "paid" | "unpaid" | null;
  isBillable: boolean;
  isRecurring: boolean;
  recurringFrequency: string | null;
  project: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
      color: string | null;
    };
  } | null;
  receiptFile?: {
    id: string;
    name: string;
    mimeType: string;
  } | null;
  createdByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

export type DateRange = {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string; // e.g. "January 2024" or "Jan 1 – Mar 31, 2024"
  preset: string; // Preset key, e.g. "this-month", "custom"
};

export type ExpenseSummary = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  overheadCents: number;
  count: number;
};

export type ExpenseDayGroupData = {
  date: string;
  expenses: Expense[];
  totalCents: number;
};
