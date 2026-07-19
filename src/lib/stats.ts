import { z } from "zod";

// Keep daily counters well past the 14-day read window so the whole window is
// always present, then let KV expire them so old days clean themselves up.
const STATS_TTL_SECONDS = 60 * 60 * 24 * 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Outcome of one /v1/chat request, derived from the response status. "other"
 * (413/400/504/…) bumps only the daily total, not a named bucket.
 */
export type StatOutcome =
  | "success"
  | "forbidden"
  | "rateLimited"
  | "kvFailure"
  | "upstreamError"
  | "other";

type CountedOutcome = Exclude<StatOutcome, "other">;

// Read boundary: KV holds untrusted JSON, so validate its shape before use.
const dailyStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  forbidden: z.number().int().nonnegative(),
  rateLimited: z.number().int().nonnegative(),
  kvFailure: z.number().int().nonnegative(),
  upstreamError: z.number().int().nonnegative(),
});

export type DailyStats = z.infer<typeof dailyStatsSchema>;

export interface DailyStatsEntry extends DailyStats {
  date: string;
}

export interface StatsReport {
  days: DailyStatsEntry[];
}

function zeroStats(): DailyStats {
  return {
    total: 0,
    success: 0,
    forbidden: 0,
    rateLimited: 0,
    kvFailure: 0,
    upstreamError: 0,
  };
}

/** UTC calendar day (YYYY-MM-DD) for a given epoch-ms instant. */
function statsDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Parse and validate a stored day; any missing/corrupt value reads as zeros. */
function parseDailyStats(raw: string | null): DailyStats {
  if (raw === null) {
    return zeroStats();
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    console.error("Discarding corrupt stats JSON:", error);
    return zeroStats();
  }
  const parsed = dailyStatsSchema.safeParse(json);
  return parsed.success ? parsed.data : zeroStats();
}

/**
 * Record one request outcome against today's counter (key `stats:YYYY-MM-DD`,
 * one JSON object per UTC day). Best-effort observability: this NEVER throws, so
 * a KV failure here logs and is swallowed rather than turning a served request
 * into an error. One KV read + one KV write per call.
 */
export async function recordOutcome(
  kv: KVNamespace,
  outcome: StatOutcome,
  nowMs: number
): Promise<void> {
  try {
    const key = `stats:${statsDate(nowMs)}`;
    const current = parseDailyStats(await kv.get(key));
    current.total += 1;
    if (outcome !== "other") {
      const counted: CountedOutcome = outcome;
      current[counted] += 1;
    }
    await kv.put(key, JSON.stringify(current), {
      expirationTtl: STATS_TTL_SECONDS,
    });
  } catch (error) {
    console.error("Failed to record usage stats:", error);
  }
}

/**
 * Read the most recent `days` daily counters (newest first). Missing days read
 * as zeros so the returned window always has a stable length and shape.
 */
export async function readRecentStats(
  kv: KVNamespace,
  nowMs: number,
  days: number
): Promise<StatsReport> {
  const reads = Array.from({ length: days }, async (_unused, index) => {
    const date = statsDate(nowMs - index * MS_PER_DAY);
    const stats = parseDailyStats(await kv.get(`stats:${date}`));
    const entry: DailyStatsEntry = { date, ...stats };
    return entry;
  });
  return { days: await Promise.all(reads) };
}
