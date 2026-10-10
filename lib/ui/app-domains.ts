// Shapes an app's domain rows for the Networking list: managed and compose-file domains together.

type Row = {
  id: string;
  domain: string;
  pathPrefix?: string | null;
  isPrimary: boolean | null;
  source?: "vardo" | "compose" | null;
  composeRouter?: string | null;
};

export type ShapedDomain<T extends Row> = T & {
  /** Set by the compose file: no edit, delete or primary. */
  readOnly: boolean;
  /** A compose router that also claims this managed domain. */
  redundantRouter: string | null;
};

const key = (r: Row) => `${r.domain.toLowerCase()}|${r.pathPrefix ?? ""}`;

/** One row per host and path, managed first when both claim it. Primary leads, then managed, then compose. */
export function shapeAppDomains<T extends Row>(rows: T[]): ShapedDomain<T>[] {
  const byKey = new Map<string, ShapedDomain<T>>();
  for (const row of rows) {
    const compose = row.source === "compose";
    const shaped: ShapedDomain<T> = {
      ...row,
      readOnly: compose,
      redundantRouter: compose ? null : (row.composeRouter ?? null),
    };
    const prev = byKey.get(key(row));
    if (!prev) {
      byKey.set(key(row), shaped);
      continue;
    }
    if (prev.readOnly && !compose) {
      byKey.set(key(row), { ...shaped, redundantRouter: shaped.redundantRouter ?? prev.composeRouter ?? null });
    } else if (!prev.readOnly && compose && !prev.redundantRouter) {
      prev.redundantRouter = row.composeRouter ?? null;
    }
  }
  const rank = (d: ShapedDomain<T>) => (d.isPrimary ? 0 : d.readOnly ? 2 : 1);
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b));
}

/** Copy for the "Manage in Vardo" confirmation. */
export function manageInVardoCopy(domain: { domain: string; pathPrefix?: string | null; composeRouter?: string | null }, otherComposeDomains: number): string {
  const route = `${domain.domain}${domain.pathPrefix ?? ""}`;
  const router = domain.composeRouter ? ` (router "${domain.composeRouter}")` : "";
  const others = otherComposeDomains > 0
    ? ` On the next deploy Vardo drops this app's other Traefik labels unless their service sets vardo.traefik=manual, so manage the other ${otherComposeDomains === 1 ? "compose domain" : `${otherComposeDomains} compose domains`} too.`
    : "";
  return `Vardo will route ${route} and you can edit it here. Remove its Traefik label${router} from your compose file; Vardo won't change your repository.${others}`;
}
