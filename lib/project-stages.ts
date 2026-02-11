import type { ProjectStage } from "@/lib/db/schema";

/**
 * Defines what UI capabilities are available at each project stage.
 * Used to show/hide/disable sections across the project dashboard and related pages.
 */

export type StageCapabilities = {
  /** Can create and manage tasks */
  tasks: boolean;
  /** Can log time entries */
  timeEntry: boolean;
  /** Can view time/revenue stats */
  stats: boolean;
  /** Can create new tasks */
  newTask: boolean;
  /** Can edit project settings */
  editProject: boolean;
  /** Can manage expenses */
  expenses: boolean;
  /** Can create/edit documents */
  editDocuments: boolean;
  /** Can manage files */
  files: boolean;
  /** Can manage client invitations */
  invitations: boolean;
  /** Can export data */
  exports: boolean;
  /** Read-only mode (disables all writes) */
  readOnly: boolean;
};

const STAGE_CAPABILITIES: Record<ProjectStage, StageCapabilities> = {
  getting_started: {
    tasks: false,
    timeEntry: false,
    stats: false,
    newTask: false,
    editProject: true,
    expenses: false,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: false,
    readOnly: false,
  },
  proposal: {
    tasks: true,
    timeEntry: false,
    stats: false,
    newTask: true,
    editProject: true,
    expenses: false,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: false,
    readOnly: false,
  },
  agreement: {
    tasks: true,
    timeEntry: false,
    stats: false,
    newTask: true,
    editProject: true,
    expenses: false,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: false,
    readOnly: false,
  },
  onboarding: {
    tasks: false,
    timeEntry: false,
    stats: false,
    newTask: false,
    editProject: true,
    expenses: false,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: false,
    readOnly: false,
  },
  active: {
    tasks: true,
    timeEntry: true,
    stats: true,
    newTask: true,
    editProject: true,
    expenses: true,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: true,
    readOnly: false,
  },
  ongoing: {
    tasks: true,
    timeEntry: true,
    stats: true,
    newTask: true,
    editProject: true,
    expenses: true,
    editDocuments: true,
    files: true,
    invitations: true,
    exports: true,
    readOnly: false,
  },
  offboarding: {
    tasks: false,
    timeEntry: false,
    stats: true,
    newTask: false,
    editProject: true,
    expenses: false,
    editDocuments: false,
    files: true,
    invitations: true,
    exports: true,
    readOnly: false,
  },
  completed: {
    tasks: false,
    timeEntry: false,
    stats: true,
    newTask: false,
    editProject: false,
    expenses: false,
    editDocuments: false,
    files: false,
    invitations: false,
    exports: true,
    readOnly: true,
  },
};

export function getStageCapabilities(stage: ProjectStage | null): StageCapabilities {
  return STAGE_CAPABILITIES[stage || "getting_started"];
}

/** Stage context — description and primary action hint for the banner */
export type StageContext = {
  description: string;
  hint: string | null;
};

const STAGE_CONTEXT: Record<ProjectStage, StageContext> = {
  getting_started: {
    description: "Setting up the project and establishing expectations.",
    hint: "Create a proposal when you're ready to define scope.",
  },
  proposal: {
    description: "Defining scope and pricing for the engagement.",
    hint: "Send the proposal for the client to review.",
  },
  agreement: {
    description: "Formalizing the engagement before work begins.",
    hint: "Waiting for the client to accept the agreement.",
  },
  onboarding: {
    description: "Gathering access, contacts, and assets to get started.",
    hint: "Mark onboarding complete when everything is in place.",
  },
  active: {
    description: "Work is underway.",
    hint: null,
  },
  ongoing: {
    description: "Ongoing maintenance and support.",
    hint: null,
  },
  offboarding: {
    description: "Wrapping up the engagement and preparing for handoff.",
    hint: "Complete data exports and migration checklist.",
  },
  completed: {
    description: "This project is complete and archived.",
    hint: null,
  },
};

export function getStageContext(stage: ProjectStage | null): StageContext {
  return STAGE_CONTEXT[stage || "getting_started"];
}
