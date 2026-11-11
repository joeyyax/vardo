// "Test connection": the UPSes a NUT server reports and their current status.

import { z } from "zod";
import { withNutSession, type NutTarget } from "./client";
import { NUT_DEFAULT_PORT, NutError } from "./protocol";
import { readingFromVars } from "./status";

const PROBE_UPS_LIMIT = 16;

export const noBreaks = (label: string) => z.string().max(256).refine((v) => !/[\r\n]/.test(v), `${label} can't contain line breaks`);

/** Hostnames, IPv4 and bracketless IPv6. */
export const upsHostSchema = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/, "Enter a hostname or IP address");
export const upsPortSchema = z.coerce.number().int().min(1).max(65535);

export const upsConnectionSchema = z.object({
  host: upsHostSchema,
  port: upsPortSchema.default(NUT_DEFAULT_PORT),
  username: noBreaks("Username").optional().nullable(),
  password: noBreaks("Password").optional().nullable(),
  tls: z.boolean().default(false),
});

export const upsNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._@-]+$/, "Use the UPS name the NUT server lists");

export type ProbeUps = {
  name: string;
  description: string;
  status: string | null;
  charge: number | null;
  runtime: number | null;
  model: string | null;
  mfr: string | null;
  /** Why its variables couldn't be read. */
  error?: string;
};

export type ProbeResult = { ok: true; version: string; upses: ProbeUps[] } | { ok: false; error: string };

function message(err: unknown): string {
  if (err instanceof NutError) {
    if (err.code === "ACCESS-DENIED") return "The NUT server refused these credentials (ACCESS-DENIED).";
    return `The NUT server replied ERR ${err.code}.`;
  }
  const text = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED/.test(text)) return "Connection refused. Check the host, the port and that upsd listens on the network.";
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "That hostname doesn't resolve.";
  return text;
}

export async function probeNutServer(target: NutTarget): Promise<ProbeResult> {
  try {
    return await withNutSession(target, async (s) => {
      const version = await s.ver().catch(() => "");
      const listed = (await s.listUps()).slice(0, PROBE_UPS_LIMIT);
      const upses: ProbeUps[] = [];
      for (const u of listed) {
        try {
          const r = readingFromVars(await s.listVar(u.name));
          upses.push({ name: u.name, description: u.description, status: r.status, charge: r.charge, runtime: r.runtime, model: r.model, mfr: r.mfr });
        } catch (err) {
          upses.push({ name: u.name, description: u.description, status: null, charge: null, runtime: null, model: null, mfr: null, error: message(err) });
        }
      }
      return { ok: true as const, version: version.replace(/^OK\s*/, ""), upses };
    });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}
