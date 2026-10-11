import { NotFoundGhost } from "@/components/not-found-ghost";
import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { notFoundLine } from "@/lib/probe-guard/responses";

// Also serves unknown hosts, which Traefik rewrites to /unknown-host.
export default async function NotFound() {
  const humor = await getProbeGuardSettings().then((s) => s.humor).catch(() => false);
  return <NotFoundGhost line={notFoundLine(humor)} />;
}
