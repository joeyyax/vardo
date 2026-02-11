// Minimal layout for the bridge iframe — no app chrome, no marketing nav.
// The root layout still provides <html>/<body>.
export default function BridgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
