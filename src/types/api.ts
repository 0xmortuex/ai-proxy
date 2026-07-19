/** Bindings and vars provided by wrangler.toml / secrets. Validated at runtime in lib/env.ts. */
export interface Env {
  RATE_LIMIT: KVNamespace;
  UPSTREAM_URL: string;
  UPSTREAM_API_KEY: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_MODELS: string;
  MAX_OUTPUT_TOKENS?: string;
  RATE_LIMIT_MAX?: string;
  UPSTREAM_AUTH_SCHEME?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  STATS_TOKEN: string;
}

/** Validated, parsed configuration derived from Env. */
export interface Config {
  upstreamUrl: string;
  upstreamApiKey: string;
  allowedOrigins: readonly string[];
  allowedModels: readonly string[];
  maxOutputTokens: number;
  rateLimitMax: number;
  authScheme: "bearer" | "x-api-key";
  timeoutMs: number;
  rateLimitKv: KVNamespace;
  statsToken: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
