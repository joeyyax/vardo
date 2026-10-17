// Per-link opt-ins, sent both ways on every heartbeat so each side learns what the other accepts.

type AcceptFlags = {
  acceptWebhookRelay: boolean;
  acceptInstanceSignin: boolean;
  acceptInstanceBrowse: boolean;
  acceptBuilds: boolean;
};

export type AcceptsPayload = {
  acceptsWebhookRelay: boolean;
  acceptsInstanceSignin: boolean;
  acceptsInstanceBrowse: boolean;
  acceptsBuilds: boolean;
};

type PeerAcceptsColumns = Partial<{
  peerAcceptsWebhookRelay: boolean;
  peerAcceptsInstanceSignin: boolean;
  peerAcceptsInstanceBrowse: boolean;
  peerAcceptsBuilds: boolean;
}>;

/** What this side accepts from `peer`, as sent to it. */
export function acceptsPayload(peer: Partial<AcceptFlags> | null | undefined): AcceptsPayload {
  return {
    acceptsWebhookRelay: peer?.acceptWebhookRelay ?? false,
    acceptsInstanceSignin: peer?.acceptInstanceSignin ?? false,
    acceptsInstanceBrowse: peer?.acceptInstanceBrowse ?? false,
    acceptsBuilds: peer?.acceptBuilds ?? false,
  };
}

/** Columns to store from what the peer said it accepts. Fields an older version leaves out stay as they are. */
export function peerAcceptsColumns(sent: unknown): PeerAcceptsColumns {
  const s = sent && typeof sent === "object" ? (sent as Record<string, unknown>) : {};
  return {
    ...(typeof s.acceptsWebhookRelay === "boolean" && { peerAcceptsWebhookRelay: s.acceptsWebhookRelay }),
    ...(typeof s.acceptsInstanceSignin === "boolean" && { peerAcceptsInstanceSignin: s.acceptsInstanceSignin }),
    ...(typeof s.acceptsInstanceBrowse === "boolean" && { peerAcceptsInstanceBrowse: s.acceptsInstanceBrowse }),
    ...(typeof s.acceptsBuilds === "boolean" && { peerAcceptsBuilds: s.acceptsBuilds }),
  };
}
