import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { withStreamCap } from "@/lib/api/stream-cap";

const sse = () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
const req = (cookie = "a") =>
  new NextRequest("http://localhost/s", { headers: { cookie: `better-auth.session_token=${cookie}` } });

describe("withStreamCap", () => {
  it("rejects the connection past the cap and frees a slot when one cancels", async () => {
    const GET = withStreamCap(async () => sse(), 2);
    const first = await GET(req("cap"));
    await GET(req("cap"));
    expect((await GET(req("cap"))).status).toBe(429);

    await first.body!.cancel();
    expect((await GET(req("cap"))).status).toBe(200);
  });

  it("counts callers separately", async () => {
    const GET = withStreamCap(async () => sse(), 1);
    await GET(req("one"));
    expect((await GET(req("two"))).status).toBe(200);
  });

  it("does not hold a slot for a response that is not a stream", async () => {
    const GET = withStreamCap(async () => new Response("no", { status: 401 }), 1);
    await GET(req("plain"));
    expect((await GET(req("plain"))).status).toBe(401);
  });

  it("frees the slot when the stream ends on its own", async () => {
    const GET = withStreamCap(
      async () => new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } }),
      1,
    );
    const res = await GET(req("ends"));
    await res.text();
    expect((await GET(req("ends"))).status).toBe(200);
  });

  it("frees the slot when the handler throws", async () => {
    const GET = withStreamCap(async () => { throw new Error("boom"); }, 1);
    await expect(GET(req("throws"))).rejects.toThrow("boom");
    await expect(GET(req("throws"))).rejects.toThrow("boom");
  });
});
