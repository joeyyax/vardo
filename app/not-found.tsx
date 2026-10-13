import { NotFoundGhost } from "@/components/not-found-ghost";

// Also serves unknown hosts, which Traefik rewrites to /unknown-host.
export default function NotFound() {
  return <NotFoundGhost line="there's nothing here" />;
}
