export type FileKind = "uploaded" | "generated";

export type UnifiedFile = {
  id: string; // prefixed: "file_xxx" or "doc_xxx"
  kind: FileKind;
  name: string; // filename or document title
  createdAt: string;
  createdBy: { id: string; name: string | null; email: string } | null;
  tags: string[];
  isPublic: boolean;

  // Uploaded-specific
  sizeBytes?: number;
  mimeType?: string;

  // Generated-specific
  documentType?:
    | "proposal"
    | "contract"
    | "change_order"
    | "orientation"
    | "addendum";
  documentStatus?: "draft" | "sent" | "viewed" | "accepted" | "declined";
  publicToken?: string | null;
  sentAt?: string | null;

  // Superseding
  replacesId?: string | null;
  replacedById?: string | null;
  previousVersions?: UnifiedFile[];

  // Source reference (for routing/actions)
  sourceTable: "project_files" | "documents";
  sourceId: string;

  // Cross-project context (used in client-level aggregation)
  projectId?: string;
  projectName?: string;
};
