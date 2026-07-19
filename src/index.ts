import { chatRequestSchema } from "./lib/chat-schema";
import { corsHeaders, handlePreflight, resolveAllowedOrigin } from "./lib/cors";
import { loadConfig } from "./lib/env";
import { jsonError, jsonOk, readBodyWithLimit } from "./lib/http";
import { checkRateLimit, type RateLimitResult } from "./lib/rate-limit";
import type { Config, Env } from "./types/api";

const MAX_BODY_BYTES = 100 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";
// How long to ask clients to wait when KV is unreachable and we fail closed.
const KV_OUTAGE_RETRY_AFTER_SECONDS = 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error("Invalid worker configuration:", error);
      return jsonError(500, "Service misconfigured");
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return jsonError(405, "Method not allowed", { Allow: "GET" });
      }
      return jsonOk({ status: "ok" });
    }

    if (url.pathname === "/v1/chat") {
      if (request.method === "OPTIONS") {
        return handlePreflight(request, config.allowedOrigins);
      }
      if (request.method !== "POST") {
        return jsonError(405, "Method not allowed", { Allow: "POST, OPTIONS" });
      }
      return handleChat(request, config);
    }

    return jsonError(404, "Not found");
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, config: Config): Promise<Response> {
  const origin = resolveAllowedOrigin(request, config.allowedOrigins);
  if (origin === null) {
    return jsonError(403, "Origin not allowed");
  }
  const cors = corsHeaders(origin);

  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  let result: RateLimitResult;
  try {
    result = await checkRateLimit(
      config.rateLimitKv,
      clientIp,
      config.rateLimitMax,
      Date.now()
    );
  } catch (error) {
    // Fail closed: KV is the only spend control on a paid key (the Origin
    // allowlist is browser-enforced and trivially spoofed). If we cannot
    // read or record usage, we must not forward the request upstream.
    console.error("Rate limit check failed:", error);
    cors.set("Retry-After", String(KV_OUTAGE_RETRY_AFTER_SECONDS));
    return jsonError(503, "Service temporarily unavailable", cors);
  }
  if (!result.allowed) {
    cors.set("Retry-After", String(result.retryAfterSeconds));
    return jsonError(429, "Rate limit exceeded", cors);
  }

  const bodyResult = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (bodyResult.kind === "too-large") {
    return jsonError(413, "Request body too large", cors);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(bodyResult.bytes));
  } catch (error) {
    console.error("Request body is not valid JSON:", error);
    return jsonError(400, "Invalid JSON body", cors);
  }

  const validation = chatRequestSchema.safeParse(parsedBody);
  if (!validation.success) {
    console.error("Request body failed validation:", validation.error.issues);
    return jsonError(400, "Invalid request body", cors);
  }
  const wantsStream = validation.data.stream === true;

  const upstreamHeaders = new Headers({ "Content-Type": "application/json" });
  if (config.authScheme === "x-api-key") {
    upstreamHeaders.set("x-api-key", config.upstreamApiKey);
    upstreamHeaders.set("anthropic-version", ANTHROPIC_VERSION);
  } else {
    upstreamHeaders.set("Authorization", `Bearer ${config.upstreamApiKey}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyResult.bytes,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      console.error(`Upstream timed out after ${config.timeoutMs}ms`);
      return jsonError(504, "Upstream timeout", cors);
    }
    console.error("Upstream request failed:", error);
    return jsonError(502, "Upstream request failed", cors);
  }

  if (!upstream.ok) {
    let detail = "";
    try {
      detail = (await upstream.text()).slice(0, 500);
    } catch (error) {
      console.error("Failed to read upstream error body:", error);
    } finally {
      clearTimeout(timer);
    }
    console.error(`Upstream returned ${upstream.status}: ${detail}`);
    return jsonError(502, "Upstream error", cors);
  }

  if (wantsStream) {
    // Stop the timeout from killing a healthy long-lived stream; it only
    // bounds the time to response headers. Pipe the body straight through.
    clearTimeout(timer);
    const headers = new Headers(cors);
    headers.set(
      "Content-Type",
      upstream.headers.get("Content-Type") ?? "text/event-stream"
    );
    headers.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: 200, headers });
  }

  let upstreamData: unknown;
  try {
    upstreamData = await upstream.json();
  } catch (error) {
    console.error("Upstream returned non-JSON response:", error);
    return jsonError(502, "Upstream error", cors);
  } finally {
    clearTimeout(timer);
  }

  return jsonOk(upstreamData, cors);
}
