// What linked instances send each other: paths and payload shapes. Shared by the serving and probing sides.

import { z } from "zod";

export const WATCH_PATH = "/api/v1/mesh/uptime/watch";
export const RESULTS_PATH = "/api/v1/mesh/uptime/results";

export const MAX_WATCH_BODY_BYTES = 16_384;
export const MAX_RESULTS_BODY_BYTES = 4_000_000;
export const MAX_WATCH_ENTRIES = 5000;
export const MAX_RECORDS_PER_PUSH = 200;
export const MAX_RESULTS_PER_RECORD = 2000;

export const identitySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().max(160).nullable(),
  publicKey: z.string().min(1).max(2000),
});
export type VantageIdentity = z.infer<typeof identitySchema>;

export const watchRequestSchema = z.object({ vantage: identitySchema });

const signedSchema = z.object({ payload: z.string().min(1).max(2_000_000), sig: z.string().min(1).max(200) });

export const watchResponseSchema = z.object({ vantage: identitySchema, watch: signedSchema });

export const resultsRequestSchema = z.object({ records: z.array(signedSchema).min(1).max(MAX_RECORDS_PER_PUSH) });

export const resultsResponseSchema = z.object({
  accepted: z.number().int(),
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});

const timeout = z.number().int().min(1000).max(60_000);
const port = z.number().int().min(1).max(65535);

/** A check as a peer sent it. Anything outside these shapes is dropped before it runs. */
export const checkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    url: z.string().max(2048).refine((v) => /^https?:\/\//i.test(v), "http or https only"),
    expectedStatus: z.object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) }),
    keyword: z.string().max(200).optional(),
    timeoutMs: timeout,
  }),
  z.object({ type: z.literal("tcp"), host: z.string().min(1).max(253), port, timeoutMs: timeout.optional() }),
  z.object({ type: z.literal("tls"), host: z.string().min(1).max(253), port, warnDays: z.number().int().min(1).max(365), timeoutMs: timeout.optional() }),
]);

export const watchEntrySchema = z.object({
  monitorId: z.string().min(1).max(100),
  check: checkSchema,
  intervalSec: z.union([z.literal(30), z.literal(60), z.literal(300)]),
  path: z.enum(["public", "mesh"]).optional(),
  headers: z.record(z.string().max(64), z.string().max(1024)).refine((h) => Object.keys(h).length <= 10, "Too many headers").optional(),
  periodSec: z.number().int().min(30).max(86_400 * 7).optional(),
  offsetMs: z.number().int().min(0).max(86_400 * 7 * 1000).optional(),
});

export const linkPatchSchema = z
  .object({
    /** The peer checks this instance. */
    checksThisInstance: z.boolean().optional(),
    /** This instance checks the peer. */
    thisInstanceChecks: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.checksThisInstance !== undefined || d.thisInstanceChecks !== undefined, { message: "Nothing to change" });
export type LinkPatch = z.infer<typeof linkPatchSchema>;
