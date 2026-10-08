import { RestoreFlow } from "./restore-flow";

export const dynamic = "force-dynamic";

export const metadata = { title: "Restore from backup" };

export default function RestorePage() {
  return <RestoreFlow />;
}
