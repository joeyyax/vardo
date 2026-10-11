import { describe, expect, it, vi } from "vitest";
import {
  checkStream,
  describeSmoke,
  firstEvent,
  parseFrames,
  smokeStreams,
  streamChecks,
  type StreamCheck,
} from "@/lib/docker/stream-smoke";

const encoder = new TextEncoder();

/** A body that sends `chunks` and then stays open unless `close` is set. */
function body(chunks: string[], close = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

const CHECK: StreamCheck = { name: "org stats", path: "/api/v1/organizations/org-1/stats/stream", event: "point" };

describe("parseFrames", () => {
  it("keeps a partial frame for the next chunk", () => {
    const { frames, rest } = parseFrames('event: point\ndata: {"a":1}\n\nevent: po');
    expect(frames).toEqual([{ event: "point", data: '{"a":1}' }]);
    expect(rest).toBe("event: po");
  });

  it("skips comments such as keepalives", () => {
    expect(parseFrames(": keepalive\n\n").frames).toEqual([]);
  });
});

describe("firstEvent", () => {
  it("resolves on the data event, even split across chunks", async () => {
    const result = await firstEvent(body([": keepalive\n\nevent: poi", 'nt\ndata: {"cpu":1}\n\n']), "point", 1000);
    expect(result).toEqual({ ok: true });
  });

  it("fails when the stream ends with an error event", async () => {
    const result = await firstEvent(body(['event: error\ndata: {"message":"boom"}\n\n']), "point", 1000);
    expect(result).toEqual({ ok: false, reason: 'stream sent error: {"message":"boom"}' });
  });

  it("fails when the stream closes before any data", async () => {
    const result = await firstEvent(body([], true), "point", 1000);
    expect(result).toEqual({ ok: false, reason: "stream closed before any data" });
  });

  it("times out on a stream that stays silent", async () => {
    const result = await firstEvent(body([": keepalive\n\n"]), "point", 20);
    expect(result).toEqual({ ok: false, reason: "no point event in 0s" });
  });
});

describe("checkStream", () => {
  const respond = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;

  it("signs in with the token and passes on a point event", async () => {
    const fetchImpl = respond(new Response(body(['event: point\ndata: {}\n\n']), { status: 200 }));
    const result = await checkStream("http://console.example.com:3000", CHECK, "vardo_t", { fetchImpl, timeoutMs: 1000 });

    expect(result.ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://console.example.com:3000/api/v1/organizations/org-1/stats/stream");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer vardo_t" });
  });

  it("fails on 204, which the routes send without a metrics provider", async () => {
    const result = await checkStream("http://c", CHECK, "t", { fetchImpl: respond(new Response(null, { status: 204 })) });
    expect(result).toEqual({ name: "org stats", ok: false, reason: "204: no metrics provider in the console" });
  });

  it("fails on an error status", async () => {
    const result = await checkStream("http://c", CHECK, "t", { fetchImpl: respond(new Response("no", { status: 403 })) });
    expect(result).toEqual({ name: "org stats", ok: false, reason: "HTTP 403" });
  });

  it("reports a connection error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkStream("http://c", CHECK, "t", { fetchImpl });
    expect(result).toEqual({ name: "org stats", ok: false, reason: "ECONNREFUSED" });
  });
});

describe("smokeStreams", () => {
  const target = { orgId: "org-1", appId: "app-1", projectId: "proj-1" };

  it("checks the org, project and app stats streams", () => {
    expect(streamChecks(target).map((c) => c.path)).toEqual([
      "/api/v1/organizations/org-1/stats/stream",
      "/api/v1/organizations/org-1/projects/proj-1/stats/stream",
      "/api/v1/organizations/org-1/apps/app-1/stats/stream",
    ]);
  });

  it("skips without metrics, before minting a token", async () => {
    const mint = vi.fn();
    const outcome = await smokeStreams("http://c", target, { deps: { metricsOn: async () => false, mint } });
    expect(outcome).toEqual({ kind: "skipped", reason: "metrics are off" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("skips when API tokens are off", async () => {
    const outcome = await smokeStreams("http://c", target, {
      deps: { metricsOn: async () => true, tokensOn: async () => false },
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "API tokens are off" });
  });

  it("revokes the token after the checks, even when one fails", async () => {
    const revoke = vi.fn(async () => {});
    const check = vi.fn(async (_base: string, c: StreamCheck) =>
      c.name === "app stats" ? { name: c.name, ok: false as const, reason: "HTTP 500" } : { name: c.name, ok: true as const, waitedMs: 5 },
    );
    const outcome = await smokeStreams("http://c", target, {
      deps: { metricsOn: async () => true, tokensOn: async () => true, mint: async () => ({ token: "t", revoke }), check },
    });

    expect(check).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledOnce();
    expect(outcome.kind === "ran" && outcome.results.filter((r) => !r.ok)).toHaveLength(1);
  });
});

describe("describeSmoke", () => {
  it("names the streams that sent nothing", () => {
    const { lines, failure } = describeSmoke(
      {
        kind: "ran",
        results: [
          { name: "org stats", ok: true, waitedMs: 1200 },
          { name: "app stats", ok: false, reason: "no point event in 20s" },
        ],
      },
      "green",
    );
    expect(lines).toEqual(["[smoke] org stats stream sent data after 1.2s", "[smoke] app stats stream: no point event in 20s"]);
    expect(failure).toBe("the live stats on green sent no data (app stats: no point event in 20s)");
  });

  it("is no failure when skipped", () => {
    expect(describeSmoke({ kind: "skipped", reason: "metrics are off" }, "blue").failure).toBeNull();
  });
});
