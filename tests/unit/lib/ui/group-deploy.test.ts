import { describe, expect, it } from "vitest";
import { queuedCount, queuedDeploysText } from "@/lib/ui/group-deploy";

const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
  );

describe("queuedCount", () => {
  it("reads the count from the queued event, across chunk breaks", async () => {
    expect(await queuedCount(stream("event: que", 'ued\ndata: {"count":3}\n\n', "event: log\ndata: {}\n\n"))).toBe(3);
  });

  it("is null when the stream ends without one", async () => {
    expect(await queuedCount(stream('event: log\ndata: {"line":"x"}\n\n'))).toBeNull();
  });
});

describe("queuedDeploysText", () => {
  it("counts the deploys, or names the project without a count", () => {
    expect(queuedDeploysText(3, "Wait UI")).toBe("Queued 3 deploys");
    expect(queuedDeploysText(1, "Wait UI")).toBe("Queued 1 deploy");
    expect(queuedDeploysText(null, "Wait UI")).toBe("Queued a deploy of every app in Wait UI");
  });
});
