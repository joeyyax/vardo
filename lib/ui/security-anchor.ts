import { findingAnchor } from "@/lib/ui/hrefs";

/** A finding's stable id within a scan: its type and title, slugged. Findings carry no id of their own. */
export function findingId(finding: { type: string; title: string }): string {
  const slug = `${finding.type}-${finding.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "finding";
}

/** Element ids for a scan's findings in order. A repeat gets a numeric suffix. */
export function findingAnchors(findings: { type: string; title: string }[]): string[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const id = findingId(f);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return findingAnchor(n === 1 ? id : `${id}-${n}`);
  });
}
