import type React from "react";
import { db } from "@/lib/db";
import { documents, projects, organizations } from "@/lib/db/schema";
import type { DocumentContent, RenderedSection } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sendEmail, getProjectRecipients } from "@/lib/email/send";
import {
  agreementReadyEmail,
  agreementAcceptedEmail,
} from "@/lib/email/lifecycle-emails";

/**
 * Generate an agreement (contract) document from an accepted proposal.
 * Called automatically when a proposal is accepted.
 */
export async function generateAgreementFromProposal(
  proposalId: string,
  projectId: string,
  organizationId: string
) {
  // Fetch the accepted proposal
  const proposal = await db.query.documents.findFirst({
    where: eq(documents.id, proposalId),
  });

  if (!proposal || proposal.type !== "proposal" || proposal.status !== "accepted") {
    throw new Error("Proposal must be accepted to generate agreement");
  }

  const proposalContent = proposal.content as DocumentContent;

  // Build agreement sections from proposal content
  const agreementSections: RenderedSection[] = [
    {
      id: nanoid(8),
      key: "intro",
      title: "Agreement Overview",
      content: `This agreement formalizes the engagement described in the accepted proposal "${proposal.title}". By accepting this agreement, both parties confirm the scope, terms, and conditions outlined below.`,
      mode: "static",
      order: 0,
      visible: true,
    },
  ];

  // Copy relevant sections from the proposal (by key)
  const sectionKeysToCopy = ["scope", "deliverables", "timeline", "pricing", "terms"];

  let order = 1;
  for (const sectionKey of sectionKeysToCopy) {
    const proposalSection = proposalContent.sections?.find(
      (s) => s.key === sectionKey
    );
    if (proposalSection && proposalSection.content?.trim()) {
      agreementSections.push({
        id: nanoid(8),
        key: proposalSection.key,
        title: proposalSection.title,
        content: proposalSection.content,
        mode: proposalSection.mode,
        order: order++,
        visible: true,
      });
    }
  }

  // Copy remaining sections not already copied
  const copiedKeys = new Set(["intro", ...sectionKeysToCopy]);
  const extraSections =
    proposalContent.sections?.filter((s) => !copiedKeys.has(s.key)) || [];
  for (const section of extraSections) {
    if (section.content?.trim()) {
      agreementSections.push({
        id: nanoid(8),
        key: section.key,
        title: section.title,
        content: section.content,
        mode: section.mode,
        order: order++,
        visible: true,
      });
    }
  }

  // Add acceptance terms section
  agreementSections.push({
    id: nanoid(8),
    key: "acceptance",
    title: "Acceptance",
    content:
      "By accepting this agreement, both parties acknowledge and agree to the terms described above. Work will begin after onboarding is complete.",
    mode: "static",
    order: order,
    visible: true,
  });

  const agreementContent: DocumentContent = {
    sections: agreementSections,
    pricing: proposalContent.pricing,
  };

  // Create the agreement document
  const publicToken = nanoid(32);

  const [agreement] = await db
    .insert(documents)
    .values({
      organizationId,
      projectId,
      type: "contract",
      status: "draft",
      title: `Agreement — ${proposal.title.replace(/^Proposal[:\s-]*/i, "").trim() || "Engagement Terms"}`,
      content: agreementContent,
      publicToken,
      createdBy: proposal.createdBy,
    })
    .returning();

  return agreement;
}

/**
 * Advance project stage after document acceptance.
 * Called when a proposal or contract is accepted.
 */
export async function handleDocumentAcceptance(
  documentId: string,
  documentType: "proposal" | "contract" | "change_order",
  projectId: string,
  organizationId: string
) {
  if (documentType === "proposal") {
    // Proposal accepted → advance to agreement, generate agreement doc
    await db
      .update(projects)
      .set({ stage: "agreement", updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    // Generate the agreement document
    const agreement = await generateAgreementFromProposal(
      documentId,
      projectId,
      organizationId
    );

    // Send agreement-ready email to project recipients
    sendLifecycleEmail(projectId, organizationId, agreementReadyEmail);

    return { stage: "agreement", generatedDocument: agreement };
  }

  if (documentType === "contract") {
    // Agreement (contract) accepted → advance to onboarding
    // Onboarding checklist items are created lazily by the POST endpoint
    // when the checklist component first loads — single creation path avoids duplication.
    await db
      .update(projects)
      .set({ stage: "onboarding", updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    // Send agreement-accepted (onboarding) email to project recipients
    sendLifecycleEmail(projectId, organizationId, agreementAcceptedEmail);

    return { stage: "onboarding" };
  }

  return null;
}

/**
 * Helper to send lifecycle emails to project recipients.
 * Fetches project context, builds email, and sends to all invitation recipients.
 * Fire-and-forget — errors are logged but don't propagate.
 */
async function sendLifecycleEmail(
  projectId: string,
  organizationId: string,
  emailBuilder: (ctx: {
    organizationName: string;
    clientName: string;
    projectName: string;
    workspaceUrl: string;
  }) => { subject: string; react: React.ReactElement }
) {
  try {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: true },
    });
    if (!project) return;

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org) return;

    const recipients = await getProjectRecipients(projectId);
    if (recipients.length === 0) return;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const emailData = emailBuilder({
      organizationName: org.name,
      clientName: project.client.name,
      projectName: project.name,
      workspaceUrl: baseUrl,
    });

    for (const recipient of recipients) {
      sendEmail({
        to: recipient,
        subject: emailData.subject,
        react: emailData.react,
        from: `${org.name} <${process.env.EMAIL_FROM || "notifications@joeyyax.com"}>`,
      }).catch((err) =>
        console.error("Failed to send lifecycle email:", err)
      );
    }
  } catch (error) {
    console.error("Error preparing lifecycle email:", error);
  }
}
