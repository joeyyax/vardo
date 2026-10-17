import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { lifecycleChanges } = await import("@/lib/digest/collector");

const DAY = 86_400_000;
const window = { since: new Date("2026-10-12T00:00:00Z"), until: new Date("2026-10-19T00:00:00Z") };
const at = (iso: string) => new Date(iso);

describe("lifecycleChanges", () => {
  it("measures a start from the stop before it, even one before the window", () => {
    const out = lifecycleChanges(
      [
        { appId: "lonvr", action: "app.stopped", at: at("2026-09-03T12:00:00Z") },
        { appId: "lonvr", action: "app.started", at: at("2026-10-17T12:00:00Z") },
      ],
      window,
    );
    expect(out).toEqual([{ appId: "lonvr", kind: "started", at: "2026-10-17T12:00:00.000Z", stoppedMs: 44 * DAY }]);
  });

  it("keeps each app's last change in the window, oldest first, and skips apps with none", () => {
    const out = lifecycleChanges(
      [
        { appId: "jellyfin", action: "app.started", at: at("2026-10-13T08:00:00Z") },
        { appId: "jellyfin", action: "app.stopped", at: at("2026-10-15T08:00:00Z") },
        { appId: "game", action: "app.started", at: at("2026-10-14T08:00:00Z") },
        { appId: "old", action: "app.stopped", at: at("2026-10-01T08:00:00Z") },
      ],
      window,
    );
    expect(out.map((c) => [c.appId, c.kind, c.stoppedMs])).toEqual([
      ["game", "started", null],
      ["jellyfin", "stopped", null],
    ]);
  });
});
