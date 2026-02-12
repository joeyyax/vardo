import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { resolveProjectContacts } from "@/lib/contacts/resolve";
import { DocumentBuilderWrapper } from "@/components/documents/document-builder-wrapper";

type Props = {
  params: Promise<{ id: string; documentId: string }>;
};

export default async function DocumentEditorPage({ params }: Props) {
  const { id: projectId, documentId } = await params;

  let organization, session;
  try {
    const auth = await requireOrg();
    organization = auth.organization;
    session = auth.session;
  } catch {
    redirect("/login");
  }

  // Verify project belongs to org
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: {
        columns: {
          id: true,
          name: true,
          organizationId: true,
          contactEmail: true,
        },
      },
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

  // Resolve contacts with project-level override support
  const { contacts: resolvedContacts } = await resolveProjectContacts(
    projectId,
    project.client.id
  );

  const clientContactEmail =
    resolvedContacts.find((c) => c.type === "primary" && c.email)?.email ??
    resolvedContacts.find((c) => c.email)?.email ??
    project.client.contactEmail ??
    undefined;

  const serializedContacts = resolvedContacts.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    type: c.type,
  }));

  // Serialize the document for the client
  const serializedDocument = {
    id: document.id,
    type: document.type,
    status: document.status,
    title: document.title,
    content: document.content as import("@/lib/template-engine/types").DocumentContent | null,
    templateId: document.templateId,
    variableValues: document.variableValues as Record<string, string> | null,
    requiresContract: document.requiresContract ?? false,
    publicToken: document.publicToken,
    sentAt: document.sentAt?.toISOString() ?? null,
    viewedAt: document.viewedAt?.toISOString() ?? null,
    acceptedAt: document.acceptedAt?.toISOString() ?? null,
    declinedAt: document.declinedAt?.toISOString() ?? null,
    acceptedBy: document.acceptedBy,
    declinedBy: document.declinedBy,
    declineReason: document.declineReason,
  };

  return (
    <DocumentBuilderWrapper
      document={serializedDocument}
      orgId={organization.id}
      projectId={projectId}
      projectName={project.name}
      clientName={project.client.name}
      clientContactEmail={clientContactEmail}
      resolvedContacts={serializedContacts}
      organizationName={organization.name}
      currentUserId={session.user.id}
    />
  );
}
