/** Peer summary for UI components. */
export type MeshPeerSummary = {
  id: string;
  name: string;
  type: string;
  status: string;
  connectionType: "direct" | "visible";
};

/** Project instance summary for UI components. */
export type ProjectInstanceSummary = {
  id: string;
  environment: string;
  gitRef: string | null;
  status: string;
  meshPeerId: string | null;
  transferredAt: Date | null;
};
