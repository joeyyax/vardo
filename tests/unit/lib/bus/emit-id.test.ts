import { describe, expect, it, vi } from "vitest";
import type { BusEvent } from "@/lib/bus/events";

const addEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/stream/producer", () => ({ addEvent }));

const { emit, onEmit } = await import("@/lib/bus");

describe("emit", () => {
  it("stamps one id that the stream and every hook see", () => {
    const seen: BusEvent[] = [];
    onEmit("test-id", (_org, event) => seen.push(event));
    emit("org1", { type: "app.state-changed", title: "t", message: "m", appId: "a1" });
    const streamed = (addEvent.mock.calls[0] as unknown[])[1] as BusEvent;
    expect(streamed.id).toMatch(/^evt_/);
    expect(seen[0].id).toBe(streamed.id);
  });

  it("keeps an id the event already has", () => {
    emit("org1", { id: "evt_given", type: "app.state-changed", title: "t", message: "m", appId: "a1" });
    expect(((addEvent.mock.calls.at(-1) as unknown[])[1] as BusEvent).id).toBe("evt_given");
  });
});
