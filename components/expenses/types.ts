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

export type MonthRange = {
  from: string; // YYYY-MM-DD (first day of month)
  to: string; // YYYY-MM-DD (last day of month)
  label: string; // "January 2024"
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
