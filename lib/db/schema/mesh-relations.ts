import { relations } from "drizzle-orm";
import { meshPeers, projectInstances } from "./mesh";
import { projects } from "./projects";

export const meshPeersRelations = relations(meshPeers, ({ many }) => ({
  projectInstances: many(projectInstances),
}));

export const projectInstancesRelations = relations(
  projectInstances,
  ({ one }) => ({
    project: one(projects, {
      fields: [projectInstances.projectId],
      references: [projects.id],
    }),
    meshPeer: one(meshPeers, {
      fields: [projectInstances.meshPeerId],
      references: [meshPeers.id],
    }),
  })
);
