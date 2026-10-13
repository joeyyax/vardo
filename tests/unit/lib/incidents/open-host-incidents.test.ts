import { describe, it, expect, vi } from "vitest";
import { selectChain } from "@/tests/helpers/mcp-tools";

const h = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: h.select } }));

import { listOpenHostIncidents } from "@/lib/incidents/host";

const at = new Date("2026-10-13T00:00:00Z");
const row = (key: string, kind: string) => ({ key, kind, title: kind, severity: "critical", openedAt: at, updatedAt: at });

describe("listOpenHostIncidents", () => {
  it("collapses the copy recorded in each admin org to one per key", async () => {
    h.select.mockReturnValue(
      selectChain([row("host:local:host.worker-down", "host.worker-down"), row("host:local:host.worker-down", "host.worker-down"), row("host:local:host.cpu", "host.cpu")]),
    );
    const open = await listOpenHostIncidents();
    expect(open.map((i) => i.key)).toEqual(["host:local:host.worker-down", "host:local:host.cpu"]);
  });
});
