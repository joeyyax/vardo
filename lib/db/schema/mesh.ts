import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { appStatusEnum, meshPeerStatusEnum, meshPeerTypeEnum } from "./enums";
import { projects } from "./projects";

// ---------------------------------------------------------------------------
// Instance Mesh — peer registry (system-level, not org-scoped)
// ---------------------------------------------------------------------------

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
  apiUrl: text("api_url"), // mesh IP URL for API calls over WireGuard tunnel (e.g. http://10.99.0.2:3000)
  publicApiUrl: text("public_api_url"), // public URL reachable without tunnel (e.g. https://console.vardo.run)
  tokenHash: text("token_hash").unique(), // SHA-256 hash of the token we gave this peer (inbound auth)
  outboundToken: text("outbound_token"), // token the peer gave us for calling their API (outbound auth)
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Instance Mesh — project-to-instance-environment mapping
// ---------------------------------------------------------------------------

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
    composeContent: text("compose_content"), // snapshot of compose config at transfer time
    sourceInstanceId: text("source_instance_id"), // which instance this deployment originated from
    transferredAt: timestamp("transferred_at"), // when the transfer happened
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
