const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Keep the daily counter well past UTC midnight so a late read never resets the
// day early; KV then expires it on its own.
const GLOBAL_TTL_SECONDS = 60 * 60 * 48;

/** UTC calendar day (YYYY-MM-DD) for a given epoch-ms instant. */
function globalDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** KV key holding the aggregate request count for the current UTC day. */
function globalKey(nowMs: number): string {
  return `global:${globalDate(nowMs)}`;
}

/** Whole seconds remaining until the next UTC midnight (always ≥ 1). */
export function secondsUntilUtcMidnight(nowMs: number): number {
  const dayIndex = Math.floor(nowMs / MS_PER_DAY);
  const nextMidnightMs = (dayIndex + 1) * MS_PER_DAY;
  return Math.max(1, Math.ceil((nextMidnightMs - nowMs) / 1000));
}

/** Parse a stored counter string; any missing/corrupt value reads as 0. */
function parseCount(stored: unknown): number {
  if (typeof stored === "string") {
    const parsed = Number.parseInt(stored, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

export interface GlobalCapResult {
  allowed: boolean;
  /** The current day's count, reused by consumeGlobalBudget to avoid a re-read. */
  count: number;
  retryAfterSeconds: number;
}

/**
 * Read and evaluate the aggregate daily cap across ALL callers, keyed by UTC
 * day. This closes the IP-rotation gap: the per-IP limiter hands a rotating
 * attacker a fresh bucket per IP, but every caller shares this one counter.
 *
 * This ONLY reads — the count is consumed later, by consumeGlobalBudget, so
 * requests rejected before they reach upstream never spend global budget.
 * Throws on a KV read failure; the caller must fail closed (503), because a
 * counter that can't be read must never be treated as "under the cap".
 */
export async function checkGlobalCap(
  kv: KVNamespace,
  max: number,
  nowMs: number
): Promise<GlobalCapResult> {
  const count = parseCount(await kv.get(globalKey(nowMs)));
  return {
    allowed: count < max,
    count,
    retryAfterSeconds: secondsUntilUtcMidnight(nowMs),
  };
}

/**
 * Consume one unit of global daily budget. Called only for requests that are
 * about to reach upstream, so bad-origin / bad-model / over-ceiling rejections
 * never count against the cap. Reuses the count already read by checkGlobalCap,
 * so it adds a single KV write and no extra read.
 *
 * Throws on a KV write failure; the caller must fail closed (503) and NOT
 * forward upstream, so a broken counter can't become unlimited spend.
 */
export async function consumeGlobalBudget(
  kv: KVNamespace,
  nowMs: number,
  count: number
): Promise<void> {
  await kv.put(globalKey(nowMs), String(count + 1), {
    expirationTtl: GLOBAL_TTL_SECONDS,
  });
}

/** Read just the current UTC day's aggregate count (for GET /stats). */
export async function readGlobalCount(
  kv: KVNamespace,
  nowMs: number
): Promise<number> {
  return parseCount(await kv.get(globalKey(nowMs)));
}
