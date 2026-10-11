import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { renderSecurityTxt } from "@/lib/probe-guard/robots";
import { getInstanceConfig } from "@/lib/system-settings";

export const dynamic = "force-dynamic";

const NOT_FOUND = { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } };

/** RFC 9116 contact for this console. 404 until an admin sets a contact or ACME_EMAIL is set. */
export async function GET(): Promise<Response> {
  try {
    const [settings, instance] = await Promise.all([getProbeGuardSettings(), getInstanceConfig()]);
    const contact = settings.securityContact || process.env.ACME_EMAIL?.trim() || "";
    const canonical = instance.domain ? `https://${instance.domain}/.well-known/security.txt` : undefined;
    const body = renderSecurityTxt(contact, { humor: settings.humor, canonical });
    if (!body) return new Response("Not Found\n", NOT_FOUND);
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return new Response("Not Found\n", NOT_FOUND);
  }
}
