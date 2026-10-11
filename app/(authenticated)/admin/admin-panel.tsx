"use client";

import { UserManagement } from "./admin-actions";
import { AdminOverview } from "./admin-overview";
import { AdminOrganizations } from "./admin-organizations";

type AdminPanelProps = {
  activeTab: string;
};

export function AdminPanel({ activeTab }: AdminPanelProps) {
  if (activeTab === "organizations") return <AdminOrganizations />;
  if (activeTab === "users") return <UserManagement />;
  return <AdminOverview />;
}
