export type InboxItemFile = {
  id: string;
  inboxItemId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  r2Key: string;
  source: "attachment" | "cloud_url" | null;
  createdAt: string;
};

export type InboxItem = {
  id: string;
  organizationId: string;
  resendEmailId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  status: "needs_review" | "converted" | "informational" | "discarded";
  convertedExpenseId: string | null;
  convertedTo: "expense" | "file" | "discussion" | "task" | "transfer" | null;
  convertedExpense: {
    id: string;
    description: string;
    amountCents: number;
  } | null;
  // Entity association (from client/project intake emails)
  clientId: string | null;
  projectId: string | null;
  client: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  files: InboxItemFile[];
  createdAt: string;
  updatedAt: string;
};
