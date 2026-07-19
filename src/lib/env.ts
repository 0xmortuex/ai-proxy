import { z } from "zod";
import type { Config, Env } from "../types/api";

const varsSchema = z.object({
  UPSTREAM_URL: z.string().url(),
  UPSTREAM_API_KEY: z.string().min(1),
  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter((origin) => origin.length > 0)
    )
    .pipe(z.array(z.string().url()).min(1)),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  UPSTREAM_AUTH_SCHEME: z.enum(["bearer", "x-api-key"]).default("bearer"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

let cached: Config | null = null;

/**
 * Validates env vars and the KV binding once per isolate.
 * Throws on invalid configuration; the caller maps that to a generic 500.
 */
export function loadConfig(env: Env): Config {
  if (cached !== null) {
    return cached;
  }

  const vars = varsSchema.parse({
    UPSTREAM_URL: env.UPSTREAM_URL,
    UPSTREAM_API_KEY: env.UPSTREAM_API_KEY,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
    UPSTREAM_AUTH_SCHEME: env.UPSTREAM_AUTH_SCHEME,
    UPSTREAM_TIMEOUT_MS: env.UPSTREAM_TIMEOUT_MS,
  });

  const kv: unknown = env.RATE_LIMIT;
  if (
    kv === null ||
    typeof kv !== "object" ||
    typeof (kv as KVNamespace).get !== "function" ||
    typeof (kv as KVNamespace).put !== "function"
  ) {
    throw new Error("RATE_LIMIT KV namespace binding is missing");
  }

  cached = {
    upstreamUrl: vars.UPSTREAM_URL,
    upstreamApiKey: vars.UPSTREAM_API_KEY,
    allowedOrigins: vars.ALLOWED_ORIGINS,
    rateLimitMax: vars.RATE_LIMIT_MAX,
    authScheme: vars.UPSTREAM_AUTH_SCHEME,
    timeoutMs: vars.UPSTREAM_TIMEOUT_MS,
    rateLimitKv: env.RATE_LIMIT,
  };
  return cached;
}
