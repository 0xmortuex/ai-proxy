const WINDOW_SECONDS = 3600;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in KV, keyed on client IP. KV is eventually
 * consistent, so the limit is approximate under concurrent bursts —
 * acceptable for abuse throttling, not for billing-grade quotas.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  clientIp: string,
  limit: number,
  nowMs: number
): Promise<RateLimitResult> {
  const windowIndex = Math.floor(nowMs / (WINDOW_SECONDS * 1000));
  const windowEndMs = (windowIndex + 1) * WINDOW_SECONDS * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
  const key = `rl:${clientIp}:${windowIndex}`;

  const stored: unknown = await kv.get(key);
  let count = 0;
  if (typeof stored === "string") {
    const parsed = Number.parseInt(stored, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      count = parsed;
    }
  }

  if (count >= limit) {
    return { allowed: false, retryAfterSeconds };
  }

  // Keep the key a bit past the window end so late reads still see it.
  await kv.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS + 60 });
  return { allowed: true, retryAfterSeconds };
}
