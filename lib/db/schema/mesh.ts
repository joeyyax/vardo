import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { appStatusEnum, meshPeerConnectionTypeEnum, meshPeerStatusEnum, meshPeerTypeEnum } from "./enums";
import { projects } from "./projects";
import { organizations } from "./organizations";

// Mesh peer registry. System-level, not org-scoped.

export const meshPeers = pgTable("mesh_peer", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull().unique(),
  name: text("name").notNull(),
  type: meshPeerTypeEnum("type").notNull().default("persistent"),
  status: meshPeerStatusEnum("status").notNull().default("offline"),
  endpoint: text("endpoint"), // host:port for WireGuard (null for dev behind NAT)
  publicKey: text("public_key").notNull().unique(),
  allowedIps: text("allowed_ips").notNull(), // WireGuard AllowedIPs (CIDR)
  internalIp: text("internal_ip").notNull().unique(), // WireGuard tunnel address (e.g. 10.99.0.1)
  apiUrl: text("api_url"), // API URL over the tunnel (e.g. http://10.99.0.2:3000)
  publicApiUrl: text("public_api_url"), // API URL without the tunnel
  tokenHash: text("token_hash").unique(), // SHA-256 of the token given to this peer (inbound auth)
  outboundToken: text("outbound_token"), // Token the peer issued for calling its API
  connectionType: meshPeerConnectionTypeEnum("connection_type").notNull().default("direct"), // direct = tunnel, visible = seen through a hub manifest
  sourceHubInstanceId: text("source_hub_instance_id"), // Hub that listed a visible peer
  // The only org this peer may read or write through promote, clone and pull.
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  lastSeenAt: timestamp("last_seen_at"),
  // What the peer last reported about its own Vardo, for canary update ordering.
  vardoSha: text("vardo_sha"),
  vardoShaSince: timestamp("vardo_sha_since"),
  vardoHealthy: boolean("vardo_healthy"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Mesh project-to-instance environment mapping.

export const projectInstances = pgTable(
  "project_instance",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    meshPeerId: text("mesh_peer_id").references(() => meshPeers.id, {
      onDelete: "set null",
    }),
    environment: text("environment").notNull(), // production, staging, development, or custom
    gitRef: text("git_ref"),
    composeContent: text("compose_content"), // Compose snapshot at transfer time
    sourceInstanceId: text("source_instance_id"),
    transferredAt: timestamp("transferred_at"),
    status: appStatusEnum("status").notNull().default("stopped"),
    lastDeployedAt: timestamp("last_deployed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("project_instance_peer_env_uniq").on(
      t.projectId,
      t.meshPeerId,
      t.environment
    ),
    index("project_instance_project_idx").on(t.projectId),
    index("project_instance_peer_idx").on(t.meshPeerId),
  ]
);
