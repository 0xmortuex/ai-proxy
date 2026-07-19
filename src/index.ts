import { chatRequestSchema } from "./lib/chat-schema";
import { corsHeaders, handlePreflight, resolveAllowedOrigin } from "./lib/cors";
import { loadConfig } from "./lib/env";
import {
  checkGlobalCap,
  consumeGlobalBudget,
  type GlobalCapResult,
} from "./lib/global-limit";
import { jsonError, jsonOk, readBodyWithLimit } from "./lib/http";
import { checkRateLimit, type RateLimitResult } from "./lib/rate-limit";
import {
  readRecentStats,
  recordOutcome,
  type StatOutcome,
} from "./lib/stats";
import type { Config, Env } from "./types/api";

const MAX_BODY_BYTES = 100 * 1024;
const ANTHROPIC_VERSION = "2023-06-01";
// How long to ask clients to wait when KV is unreachable and we fail closed.
const KV_OUTAGE_RETRY_AFTER_SECONDS = 30;
// How many days of daily counters GET /stats returns.
const STATS_WINDOW_DAYS = 14;

/** Map the response status of a chat request to a stats bucket. */
function outcomeForStatus(status: number): StatOutcome {
  switch (status) {
    case 200:
      return "success";
    case 403:
      return "forbidden";
    case 429:
      return "rateLimited";
    case 502:
      return "upstreamError";
    case 503:
      return "kvFailure";
    default:
      return "other";
  }
}

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

    if (url.pathname === "/stats") {
      return handleStats(request, config);
    }

    if (url.pathname === "/v1/chat") {
      if (request.method === "OPTIONS") {
        return handlePreflight(request, config.allowedOrigins);
      }
      if (request.method !== "POST") {
        return jsonError(405, "Method not allowed", { Allow: "POST, OPTIONS" });
      }
      const { response, outcome } = await handleChat(request, config);
      // Best-effort: recordOutcome never throws, so a stats KV failure logs
      // and is swallowed rather than altering the response we already have.
      // handleChat supplies an explicit outcome only where the status alone is
      // ambiguous (a 400 from validation rejection vs. a malformed body).
      await recordOutcome(
        config.rateLimitKv,
        outcome ?? outcomeForStatus(response.status),
        Date.now()
      );
      return response;
    }

    return jsonError(404, "Not found");
  },
} satisfies ExportedHandler<Env>;

/**
 * GET /stats — protected by an X-Stats-Token header matching STATS_TOKEN. A
 * missing or wrong token returns 404 (not 401) so the endpoint's existence
 * stays undiscoverable. Not rate limited and not origin-checked. The token is
 * never logged and never returned.
 */
async function handleStats(
  request: Request,
  config: Config
): Promise<Response> {
  const token = request.headers.get("X-Stats-Token");
  if (token === null || token !== config.statsToken) {
    return jsonError(404, "Not found");
  }
  if (request.method !== "GET") {
    return jsonError(405, "Method not allowed", { Allow: "GET" });
  }
  try {
    const report = await readRecentStats(
      config.rateLimitKv,
      Date.now(),
      STATS_WINDOW_DAYS,
      config.globalDailyMax
    );
    return jsonOk(report);
  } catch (error) {
    console.error("Failed to read usage stats:", error);
    return jsonError(503, "Service temporarily unavailable");
  }
}

/**
 * Result of handling a /v1/chat request. `outcome` is set only when the HTTP
 * status alone can't identify the stats bucket — specifically a 400 from
 * model-allowlist / token-ceiling rejection, which must be counted separately
 * from a malformed-body 400. When omitted, the caller derives the bucket from
 * the response status.
 */
interface ChatResult {
  response: Response;
  outcome?: StatOutcome;
}

async function handleChat(
  request: Request,
  config: Config
): Promise<ChatResult> {
  const origin = resolveAllowedOrigin(request, config.allowedOrigins);
  if (origin === null) {
    return { response: jsonError(403, "Origin not allowed") };
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
    return { response: jsonError(503, "Service temporarily unavailable", cors) };
  }
  if (!result.allowed) {
    cors.set("Retry-After", String(result.retryAfterSeconds));
    return { response: jsonError(429, "Rate limit exceeded", cors) };
  }

  // Global daily cap across ALL callers, checked after the per-IP limit and
  // before the body is even read — the per-IP limiter hands an IP-rotating
  // attacker a fresh bucket per IP, so this shared counter is the only bound on
  // aggregate spend. Read-only here; the count is consumed just before the
  // fetch, so requests rejected earlier never spend global budget.
  let globalCap: GlobalCapResult;
  try {
    globalCap = await checkGlobalCap(
      config.rateLimitKv,
      config.globalDailyMax,
      Date.now()
    );
  } catch (error) {
    // Fail closed, exactly like the per-IP limiter: a counter we can't read
    // must never be treated as headroom, or a KV outage becomes unlimited spend.
    console.error("Global cap check failed:", error);
    cors.set("Retry-After", String(KV_OUTAGE_RETRY_AFTER_SECONDS));
    return { response: jsonError(503, "Service temporarily unavailable", cors) };
  }
  if (!globalCap.allowed) {
    cors.set("Retry-After", String(globalCap.retryAfterSeconds));
    return {
      response: jsonError(429, "Daily request limit reached", cors),
      outcome: "globalLimited",
    };
  }

  const bodyResult = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (bodyResult.kind === "too-large") {
    return { response: jsonError(413, "Request body too large", cors) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(bodyResult.bytes));
  } catch (error) {
    console.error("Request body is not valid JSON:", error);
    return { response: jsonError(400, "Invalid JSON body", cors) };
  }

  const validation = chatRequestSchema.safeParse(parsedBody);
  if (!validation.success) {
    console.error("Request body failed validation:", validation.error.issues);
    return { response: jsonError(400, "Invalid request body", cors) };
  }
  const body = validation.data;

  // Constrain what callers may spend on: reject any model outside the allowlist
  // or a max_tokens above the ceiling. The 400 message is generic so it never
  // reveals the allowlist. These are the "attempted abuse" signal for /stats.
  if (
    !config.allowedModels.includes(body.model) ||
    body.max_tokens > config.maxOutputTokens
  ) {
    return {
      response: jsonError(400, "Invalid request body", cors),
      outcome: "rejected",
    };
  }

  // This request has cleared every rejection gate and is about to reach
  // upstream, so it — and only now — consumes one unit of global daily budget.
  // Bad-origin / bad-model / over-ceiling requests returned above and never got
  // here, so they don't spend the cap. Fail closed on a write failure: if we
  // can't record the spend we must not forward it, matching the per-IP limiter.
  try {
    await consumeGlobalBudget(config.rateLimitKv, Date.now(), globalCap.count);
  } catch (error) {
    console.error("Global counter write failed:", error);
    cors.set("Retry-After", String(KV_OUTAGE_RETRY_AFTER_SECONDS));
    return { response: jsonError(503, "Service temporarily unavailable", cors) };
  }

  const wantsStream = body.stream === true;

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
      return { response: jsonError(504, "Upstream timeout", cors) };
    }
    console.error("Upstream request failed:", error);
    return { response: jsonError(502, "Upstream request failed", cors) };
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
    return { response: jsonError(502, "Upstream error", cors) };
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
    return { response: new Response(upstream.body, { status: 200, headers }) };
  }

  let upstreamData: unknown;
  try {
    upstreamData = await upstream.json();
  } catch (error) {
    console.error("Upstream returned non-JSON response:", error);
    return { response: jsonError(502, "Upstream error", cors) };
  } finally {
    clearTimeout(timer);
  }

  return { response: jsonOk(upstreamData, cors) };
}
