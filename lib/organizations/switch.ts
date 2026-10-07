/** Switch the active organization. The server sets an HttpOnly cookie. */

export async function switchOrganization(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/v1/organizations/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: orgId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error || "Failed to switch organization" };
  }

  return { ok: true };
}
