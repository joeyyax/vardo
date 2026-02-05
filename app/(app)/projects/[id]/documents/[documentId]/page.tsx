import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { DocumentEditor } from "@/components/documents/document-editor";

type Props = {
  params: Promise<{ id: string; documentId: string }>;
};

export default async function DocumentEditorPage({ params }: Props) {
  const { id: projectId, documentId } = await params;

  let organization;
  try {
    const auth = await requireOrg();
    organization = auth.organization;
  } catch {
    redirect("/login");
  }

  // Verify project belongs to org
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== organization.id) {
    notFound();
  }

  // Get the document
  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, documentId),
      eq(documents.projectId, projectId),
      eq(documents.organizationId, organization.id)
    ),
  });

  if (!document) {
    notFound();
  }

  // Serialize the document for the client
  const serializedDocument = {
    id: document.id,
    type: document.type,
    status: document.status,
    title: document.title,
    content: document.content,
    requiresContract: document.requiresContract ?? false,
    publicToken: document.publicToken,
    sentAt: document.sentAt?.toISOString() ?? null,
    viewedAt: document.viewedAt?.toISOString() ?? null,
    acceptedAt: document.acceptedAt?.toISOString() ?? null,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="icon" className="squircle">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {document.type === "proposal" ? "Edit Proposal" : "Edit Contract"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {project.name}
          </p>
        </div>
      </div>

      {/* Editor */}
      <DocumentEditor
        document={serializedDocument}
        orgId={organization.id}
        projectId={projectId}
      />
    </div>
  );
}
