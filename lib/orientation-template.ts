import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import type { DocumentContent } from "@/lib/db/schema";
import { nanoid } from "nanoid";

/**
 * Template content for the "How We'll Work Together" orientation document.
 * Auto-created when a new project enters the Getting Started stage.
 */
function buildOrientationContent(): DocumentContent {
  return {
    sections: [
      {
        id: nanoid(8),
        key: "intro",
        title: "How We'll Work Together",
        content:
          "Welcome — I'm glad we're getting started.\n\nThis page explains how we'll communicate, how work moves forward, and what you can expect as we work together. The goal is to keep things clear, predictable, and low-stress for everyone.",
        mode: "static",
        order: 0,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "contact",
        title: "How to Reach Me",
        content:
          "For anything related to your project, please use the project workspace you'll have access to shortly.\n\nThat's where:\n- Tasks are tracked\n- Questions live\n- Decisions are recorded\n- Progress is visible\n\nUsing one place keeps things from getting lost and helps me respond more quickly.\n\nIf something truly urgent comes up, you can email me directly.",
        mode: "static",
        order: 1,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "availability",
        title: "Availability & Response Times",
        content:
          "I work regular business hours and try to respond thoughtfully rather than instantly.\n\nTypical response times:\n- Normal requests: within **one business day**\n- Quick clarifications: often sooner\n- Larger questions: may take a bit longer if they require context\n\nIf I'll be unavailable for an extended period, I'll always give a heads-up.",
        mode: "static",
        order: 2,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "urgent",
        title: "What Counts as Urgent",
        content:
          "Urgent issues are things that block normal use, such as:\n- A site being down\n- A critical error affecting visitors\n- Something time-sensitive that can't wait for the next business day\n\nDesign feedback, new ideas, and feature requests are important — they're just not emergencies. Those go through the normal workflow so they get the attention they deserve.",
        mode: "static",
        order: 3,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "workflow",
        title: "How Work Moves Forward",
        content:
          "We'll move through a few clear steps together:\n\n1. **Getting started** – setting expectations and alignment\n2. **Proposal** – outlining scope and pricing\n3. **Agreement** – locking in the terms so we can begin\n4. **Onboarding** – gathering access and setting things up\n5. **Active work** – tasks, updates, and progress\n6. **Ongoing support** (if applicable)\n\nYou'll always be able to see where we are and what's coming next in your dashboard.",
        mode: "static",
        order: 4,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "workspace",
        title: "Your Project Workspace",
        content:
          "You'll be invited to a project workspace where you can:\n- See the current status of the project\n- Submit and track requests\n- Review documents\n- Follow progress over time\n\nAs we move forward, you'll see each step unlock naturally.",
        mode: "static",
        order: 5,
        visible: true,
      },
      {
        id: nanoid(8),
        key: "transparency",
        title: "A Quick Note on Transparency",
        content:
          "I aim to be clear about:\n- What's in scope\n- What's not\n- What's happening now\n- What happens next\n\nIf anything ever feels unclear, just ask. Clear communication is part of the work.\n\n---\n\nI'm looking forward to working together.",
        mode: "static",
        order: 6,
        visible: true,
      },
    ],
  };
}

/**
 * Create the "How We'll Work Together" orientation document for a new project.
 */
export async function createOrientationDocument(
  projectId: string,
  organizationId: string,
  createdBy: string | null
) {
  const publicToken = nanoid(32);

  const [doc] = await db
    .insert(documents)
    .values({
      organizationId,
      projectId,
      type: "orientation",
      status: "sent", // Informational — immediately available
      title: "How We'll Work Together",
      content: buildOrientationContent(),
      publicToken,
      sentAt: new Date(),
      createdBy,
    })
    .returning();

  return doc;
}
