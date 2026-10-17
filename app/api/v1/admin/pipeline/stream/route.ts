import type { NextRequest } from "next/server";
import { withStreamCap } from "@/lib/api/stream-cap";
import { createSSEResponse } from "@/lib/api/sse";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { readStream } from "@/lib/stream/consumer";
import { PIPELINE_STREAM } from "@/lib/pipeline/events";
import { readPipelineSnapshot } from "@/lib/pipeline/read";

/** A fresh snapshot this soon after a pipeline event. */
const EVENT_DELAY_MS = 250;
/** Jobs and loops have no events: a snapshot at least this often. */
const POLL_MS = 3_000;

// GET /api/v1/admin/pipeline/stream
async function handleGet(request: NextRequest) {
  try {
    await requireAppAdmin();
    return createSSEResponse(request, async (sendEvent) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let busy = false;
      let again = false;

      const push = async (): Promise<void> => {
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          sendEvent("snapshot", await readPipelineSnapshot());
        } catch (err) {
          sendEvent("problem", { message: err instanceof Error ? err.message : "Couldn't read the pipeline" });
        } finally {
          busy = false;
        }
        if (again) {
          again = false;
          await push();
        }
      };
      const soon = (ms: number) => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          void push();
        }, ms);
      };

      await push();
      const poll = setInterval(() => soon(0), POLL_MS);
      try {
        for await (const entry of readStream(PIPELINE_STREAM, { fromId: "$", signal: request.signal, blockMs: 5_000 })) {
          if (entry) soon(EVENT_DELAY_MS);
        }
      } finally {
        clearInterval(poll);
        if (timer) clearTimeout(timer);
      }
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming the pipeline");
  }
}

export const GET = withStreamCap(handleGet);
