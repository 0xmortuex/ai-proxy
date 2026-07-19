/**
 * Returns the request's Origin header when it is on the allowlist,
 * otherwise null. Comparison is exact (scheme + host + port).
 */
export function resolveAllowedOrigin(
  request: Request,
  allowedOrigins: readonly string[]
): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    return null;
  }
  const normalized = origin.replace(/\/+$/, "");
  return allowedOrigins.includes(normalized) ? origin : null;
}

/** CORS headers echoing a single allowed origin — never "*". */
export function corsHeaders(origin: string): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return headers;
}

export function handlePreflight(
  request: Request,
  allowedOrigins: readonly string[]
): Response {
  const origin = resolveAllowedOrigin(request, allowedOrigins);
  if (origin === null) {
    return new Response(null, { status: 403 });
  }
  const headers = corsHeaders(origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}
