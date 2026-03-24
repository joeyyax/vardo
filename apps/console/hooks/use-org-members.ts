import { useState, useEffect } from "react";

export type OrgMember = {
  id: string;
  name: string | null;
  email: string;
};

export function useOrgMembers(orgId: string | undefined) {
  const [members, setMembers] = useState<OrgMember[]>([]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;

    async function fetchMembers() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/members`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setMembers(data.members);
        }
      } catch {
        // Silently fail — component can handle empty members
      }
    }

    fetchMembers();
    return () => { cancelled = true; };
  }, [orgId]);

  return members;
}
