// One HTTP request whose socket only connects to addresses the SSRF policy allows.
// Vetting at connect time closes the DNS rebinding gap between check and fetch.

import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Readable } from "node:stream";
import { alwaysBlockedReason, blockedAddressReason, BlockedUrlError } from "./ssrf";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dns.lookup replacement that fails when any resolved address is blocked, unless the host is allowlisted. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      for (const { address } of addresses) {
        const reason = alwaysBlockedReason(address);
        if (reason) {
          return callback(new BlockedUrlError(`Refusing to reach ${hostname} — it resolves to ${address} (${reason})`), []);
        }
      }
      if (!allowPrivate) {
        for (const { address } of addresses) {
          const reason = blockedAddressReason(address);
          if (reason) {
            return callback(new BlockedUrlError(`Refusing to reach ${hostname} — it resolves to ${address} (${reason})`), []);
          }
        }
      }
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      if (!first) return callback(new BlockedUrlError(`${hostname} resolved to no addresses`), []);
      callback(null, first.address, first.family);
    });
  };
}

function bodyBuffer(body: RequestInit["body"]): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  throw new TypeError("pinnedFetch supports string, buffer and URLSearchParams bodies");
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** A single request with no redirect following. `allowPrivate` is for allowlisted hosts only. */
export function pinnedFetch(
  url: URL,
  init: RequestInit & { allowPrivate?: boolean } = {},
): Promise<Response> {
  const body = bodyBuffer(init.body);
  const headers = new Headers(init.headers);
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));

  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        lookup: guardedLookup(init.allowPrivate === true) as never,
        signal: init.signal ?? undefined,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const stream = NULL_BODY_STATUS.has(status) || init.method === "HEAD"
          ? null
          : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (!stream) res.resume();
        try {
          resolve(new Response(stream, { status, statusText: res.statusMessage, headers: responseHeaders }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
