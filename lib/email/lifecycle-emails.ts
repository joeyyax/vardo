import { LifecycleEmail } from "./templates/lifecycle";

type EmailContext = {
  organizationName: string;
  clientName: string;
  projectName: string;
  workspaceUrl: string;
};

type LifecycleEmailResult = {
  subject: string;
  react: ReturnType<typeof LifecycleEmail>;
};

/**
 * Proposal sent to client for review.
 */
export function proposalReadyEmail(ctx: EmailContext): LifecycleEmailResult {
  return {
    subject: `Proposal ready for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Proposal Ready",
      previewText: `Your proposal for ${ctx.projectName} is ready for review`,
      paragraphs: [
        `Your proposal for ${ctx.projectName} is ready for review. It outlines the scope, pricing, and timeline for the engagement.`,
        "You can review the full details, ask questions, and accept or decline directly from your workspace.",
        "Take your time reviewing. If anything needs adjustment, just let me know.",
      ],
      ctaLabel: "Review Proposal",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Agreement (contract) sent to client for signing — after proposal is accepted.
 */
export function agreementReadyEmail(ctx: EmailContext): LifecycleEmailResult {
  return {
    subject: `Next step: agreement for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Agreement Ready",
      previewText: `The service agreement for ${ctx.projectName} is ready for your review`,
      paragraphs: [
        `Thanks for accepting the proposal. The next step is a service agreement that formalizes the engagement for ${ctx.projectName}.`,
        "The agreement covers the scope, terms, and conditions we discussed in the proposal. You can review and accept it from your workspace.",
        "If you have any questions about the terms, don't hesitate to reach out.",
      ],
      ctaLabel: "Review Agreement",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Agreement accepted — onboarding begins.
 */
export function agreementAcceptedEmail(
  ctx: EmailContext
): LifecycleEmailResult {
  return {
    subject: `Onboarding for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Onboarding",
      previewText: `Let's get ${ctx.projectName} set up — onboarding has started`,
      paragraphs: [
        `The agreement is signed and we're ready to get started on ${ctx.projectName}. Before diving into the work, there are a few setup items to take care of.`,
        "Your workspace has a checklist of things we'll need — contacts, access credentials, assets, and a few review items. Some of these you can complete yourself, and I'll handle the rest.",
        "This phase is usually quick. Once the essentials are in place, work begins.",
      ],
      ctaLabel: "View Onboarding Checklist",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Onboarding complete — work is starting.
 */
export function onboardingCompleteEmail(
  ctx: EmailContext
): LifecycleEmailResult {
  return {
    subject: `Work is underway on ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Work is Underway",
      previewText: `${ctx.projectName} is now active — work has begun`,
      paragraphs: [
        `Onboarding is complete and work on ${ctx.projectName} is now underway. Your workspace will be the central place for updates, tasks, and communication.`,
        "You'll be able to see progress on tasks and follow along as things move forward. If you ever need anything, your workspace is always the best place to reach me.",
        "Looking forward to building something great together.",
      ],
      ctaLabel: "Go to Workspace",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Offboarding started — wrapping up the engagement.
 */
export function offboardingStartedEmail(
  ctx: EmailContext
): LifecycleEmailResult {
  return {
    subject: `Wrapping things up for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Offboarding",
      previewText: `We're moving into the offboarding phase for ${ctx.projectName}`,
      paragraphs: [
        `This note confirms we're moving into the offboarding phase for ${ctx.projectName}.`,
        "You can export your application data at any time using the Request Application Data feature in your project workspace.",
        "If you'd like help with the transition, migration assistance is available. Otherwise, you're free to move things forward on your own timeline.",
        "Thanks again — and let me know if you need anything during the transition.",
      ],
      ctaLabel: "Go to Workspace",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Data export is ready for download.
 */
export function dataExportReadyEmail(
  ctx: EmailContext
): LifecycleEmailResult {
  return {
    subject: `Your data export is ready for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Data Export Ready",
      previewText: `Your application data for ${ctx.projectName} is ready to download`,
      paragraphs: [
        `The application data export you requested for ${ctx.projectName} is now ready.`,
        "You can download it from your project workspace. The export includes your application code, database backup, and media files.",
        "If you have any questions about the exported data or need help with the migration, don't hesitate to reach out.",
      ],
      ctaLabel: "View Export",
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}

/**
 * Offboarding complete — project is now archived.
 */
export function offboardingCompleteEmail(
  ctx: EmailContext
): LifecycleEmailResult {
  return {
    subject: `${ctx.projectName} is now complete`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: "Project Complete",
      previewText: `${ctx.projectName} has been marked as complete`,
      paragraphs: [
        `The offboarding process for ${ctx.projectName} is now complete. The project has been archived.`,
        "Your data exports will remain available in your workspace if you need them in the future.",
        "It's been a pleasure working together. If you ever need anything down the road, don't hesitate to get in touch.",
      ],
      ctaLabel: "View Project",
      ctaUrl: ctx.workspaceUrl,
      signOff: "All the best",
    }),
  };
}

/**
 * Document shared with client (generic — for orientation docs, change orders, etc.)
 */
export function documentSharedEmail(
  ctx: EmailContext & { documentTitle: string; documentType: string }
): LifecycleEmailResult {
  const typeLabel =
    ctx.documentType === "orientation"
      ? "guide"
      : ctx.documentType === "change_order"
        ? "change order"
        : "document";

  return {
    subject: `New ${typeLabel} for ${ctx.projectName}`,
    react: LifecycleEmail({
      organizationName: ctx.organizationName,
      clientName: ctx.clientName,
      projectName: ctx.projectName,
      heading: ctx.documentTitle,
      previewText: `A new ${typeLabel} has been shared for ${ctx.projectName}`,
      paragraphs: [
        `A new ${typeLabel} has been shared with you for ${ctx.projectName}: "${ctx.documentTitle}".`,
        "You can review the full details from your workspace.",
      ],
      ctaLabel: `View ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)}`,
      ctaUrl: ctx.workspaceUrl,
    }),
  };
}
