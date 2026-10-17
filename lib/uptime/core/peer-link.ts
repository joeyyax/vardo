// What a watching instance concludes about a linked peer from its signals: the console over the tunnel, its public URL, the heartbeat and its reports.

export type Signal = "up" | "down" | "unknown";

export type PeerSignals = {
  peer: string;
  self: string;
  /** The peer's console over the tunnel. */
  tunnel: Signal;
  /** The peer's public URL; `none` when it has none. */
  publicUrl: Signal | "none";
  /** Whether the mesh heartbeat is recent; null when it can't tell. */
  heartbeatFresh: boolean | null;
  /** Whether the peer's reports on its private monitors are arriving; none when it doesn't send them. */
  reports?: "fresh" | "stale" | "none";
};

export type PeerVerdictKind = "ok" | "link-down" | "peer-down" | "unreachable" | "public-down" | "silent";

export type PeerVerdict = {
  kind: PeerVerdictKind;
  /** `down` alerts as critical, `degraded` as a warning. */
  state: "up" | "degraded" | "down" | "unknown";
  title: string;
  detail: string;
};

/**
 * Tunnel down with the public URL answering is the link. Both down is the peer. A tunnel down with no public URL can't be told
 * apart, so it reads as unreachable. A stale heartbeat counts as the tunnel being down while the tunnel check has no data.
 * Reports that stop while the tunnel isn't down are their own verdict; while it's down, the link or peer verdict says why.
 */
export function judgePeerLink(s: PeerSignals): PeerVerdict {
  const tunnel: Signal = s.tunnel === "unknown" && s.heartbeatFresh === false ? "down" : s.tunnel;
  const verdict = judgeReachability(s, tunnel);
  if (s.reports !== "stale") return verdict;
  if (tunnel !== "down") {
    return {
      kind: "silent",
      state: "down",
      title: `${s.peer} stopped reporting`,
      detail: `${s.peer} answers, but its reports on its private monitors stopped reaching ${s.self}, so nothing here watches them.`,
    };
  }
  return { ...verdict, detail: `${verdict.detail} Its private monitors go unwatched until it reports again.` };
}

function judgeReachability(s: PeerSignals, tunnel: Signal): PeerVerdict {
  if (tunnel === "unknown" && s.publicUrl === "none") return { kind: "ok", state: "unknown", title: "", detail: "" };

  if (tunnel === "up") {
    if (s.publicUrl === "down") {
      return {
        kind: "public-down",
        state: "degraded",
        title: `${s.peer}'s public URL isn't answering`,
        detail: `${s.peer} answers over the mesh, but its public URL doesn't answer from ${s.self}.`,
      };
    }
    return { kind: "ok", state: "up", title: "", detail: "" };
  }

  if (tunnel === "down") {
    if (s.publicUrl === "up") {
      return {
        kind: "link-down",
        state: "down",
        title: `Link to ${s.peer} is down`,
        detail: `${s.peer} answers on its public URL, but not over the mesh from ${s.self}.`,
      };
    }
    if (s.publicUrl === "none") {
      return {
        kind: "unreachable",
        state: "down",
        title: `${s.peer} unreachable from ${s.self}`,
        detail: `${s.peer} doesn't answer over the mesh and has no public URL to tell the link from the instance.`,
      };
    }
    if (s.publicUrl === "down") {
      return {
        kind: "peer-down",
        state: "down",
        title: `${s.peer} is down`,
        detail: `${s.peer} answers neither over the mesh nor on its public URL.`,
      };
    }
    return {
      kind: "unreachable",
      state: "down",
      title: `${s.peer} unreachable from ${s.self}`,
      detail: `${s.peer} doesn't answer over the mesh.`,
    };
  }

  return { kind: "ok", state: "unknown", title: "", detail: "" };
}
