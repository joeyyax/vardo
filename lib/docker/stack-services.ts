// Vardo's own stack containers, with the idle blue/green slot marked as standby.

import { projectSlot } from "./desired-state";

export type StackContainer = {
  name: string;
  containerId: string;
  status: string;
  state: string;
  image: string;
  project: string;
};

export type StackService = Omit<StackContainer, "project"> & {
  /** Standby: the idle slot kept for instant rollback. */
  role: "service" | "standby";
};

const SHARED_PROJECT = "vardo";
// Without the console's own project, a single-segment environment: vardo-<env>-<slot>.
const FALLBACK_SLOT_RE = /^vardo-[a-z0-9_]+-(blue|green)$/;

function slotBase(project: string): string | null {
  const slot = projectSlot(project);
  return slot === "blue" || slot === "green" ? project.slice(0, -slot.length - 1) : null;
}

/** Keeps the shared stack and the console's slot projects, leaving out apps whose names start with "vardo-". */
export function stackServices(rows: readonly StackContainer[], ownProject?: string | null): StackService[] {
  const base = ownProject ? slotBase(ownProject) : null;
  const isSlot = (p: string) => (base ? slotBase(p) === base : FALLBACK_SLOT_RE.test(p));
  const stack = rows.filter((r) => r.project === SHARED_PROJECT || isSlot(r.project));

  const active =
    ownProject && isSlot(ownProject)
      ? ownProject
      : stack.find((r) => isSlot(r.project) && r.state === "running")?.project;

  const services: StackService[] = stack.map(({ project, ...r }) => ({
    ...r,
    role: active && isSlot(project) && project !== active && r.state !== "running" ? "standby" : "service",
  }));
  return [...services.filter((s) => s.role === "service"), ...services.filter((s) => s.role === "standby")];
}
