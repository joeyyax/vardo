import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function RolloutActionPage({ searchParams }: {
  searchParams: Promise<{ rollout?: string; action?: string; instance?: string }>;
}) {
  const { rollout, action, instance } = await searchParams;
  const query = new URLSearchParams();
  if (rollout) query.set("rollout", rollout);
  if (action === "immediate" || action === "skip" || action === "retry") query.set("action", action);
  if (instance) query.set("instance", instance);
  const target = `/admin/settings/maintenance${query.size ? `?${query.toString()}` : ""}#updates`;
  if (!(await getSession())) redirect(`/login?callbackUrl=${encodeURIComponent(target)}`);
  redirect(target);
}
