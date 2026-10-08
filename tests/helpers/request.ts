import { NextRequest } from "next/server";

type Init = {
  body?: unknown;
  headers?: Record<string, string>;
  /** Query string params. */
  query?: Record<string, string>;
};

/** NextRequest against localhost; a body is sent as JSON. */
export function jsonRequest(method: string, path: string, init: Init = {}) {
  const url = new URL(path, "http://localhost");
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const hasBody = init.body !== undefined && method !== "GET" && method !== "HEAD";
  return new NextRequest(url, {
    method,
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...init.headers },
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
}

/** Next 15+ route context: params arrive as a promise. */
export function routeCtx<P extends Record<string, string>>(params: P) {
  return { params: Promise.resolve(params) };
}
