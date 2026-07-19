"use strict";

// Drives the REAL compiled worker handler (dist-test/index.js) to prove the
// global daily cap: the aggregate bound that closes the IP-rotation gap the
// per-IP limiter can't. Three properties are covered here —
//   1. the cap reached returns 429 (and never forwards upstream),
//   2. a KV failure on the global counter fails closed with 503 (no upstream),
//   3. a rejected-model request does NOT consume global budget.
//
// As in the other suites, loadConfig() caches its Config once per process, so
// every test shares one env/kv reference and mutates only the kv method bodies.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../dist-test/index.js").default;

const ALLOWED_ORIGIN = "https://allowed.example.com";
const UPSTREAM_URL = "https://upstream.example.test/v1/messages";

// Shared KV double. Each test rewrites .get / .put to model the scenario. The
// global counter lives under a `global:` key; the per-IP limiter under `rl:`.
const kv = {
  get: async () => null,
  put: async () => undefined,
};

const env = {
  RATE_LIMIT: kv,
  UPSTREAM_URL,
  UPSTREAM_API_KEY: "test-secret-key",
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  ALLOWED_MODELS: "claude-opus-4-8",
  MAX_OUTPUT_TOKENS: "2048",
  RATE_LIMIT_MAX: "20",
  GLOBAL_DAILY_MAX: "200",
  UPSTREAM_AUTH_SCHEME: "x-api-key",
  UPSTREAM_TIMEOUT_MS: "60000",
  STATS_TOKEN: "test-stats-token",
};

let fetchCalls = 0;
let fetchImpl = async () =>
  new Response(JSON.stringify({ id: "msg_ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  fetchCalls = 0;
  kv.get = async () => null;
  kv.put = async () => undefined;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
});

function chatRequest(body) {
  return new Request("https://proxy.example.test/v1/chat", {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.13",
    },
    body:
      typeof body === "string"
        ? body
        : JSON.stringify(
            body ?? {
              model: "claude-opus-4-8",
              max_tokens: 16,
              messages: [{ role: "user", content: "hi" }],
            }
          ),
  });
}

test("global cap reached -> 429 with Retry-After, and never forwards upstream", async () => {
  // Per-IP read is under its limit; the global counter is already at the cap.
  kv.get = async (key) => {
    if (typeof key === "string" && key.startsWith("global:")) {
      return "200"; // == GLOBAL_DAILY_MAX, so the cap is reached
    }
    return null; // rl:* -> 0, under the per-IP limit
  };

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 429, "at the global cap a request must be rejected with 429");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "an over-cap request must NOT reach upstream");

  const retryAfter = Number(res.headers.get("Retry-After"));
  assert.ok(Number.isFinite(retryAfter), "Retry-After must be present and numeric");
  assert.ok(
    retryAfter >= 1 && retryAfter <= 86400,
    "Retry-After must be the seconds remaining until UTC midnight"
  );
});

test("a KV failure on the global counter WRITE -> 503 and no upstream call", async () => {
  // Per-IP limiter succeeds (read+write) and the global READ succeeds (under
  // cap), but consuming the global budget (its write) fails. The request must
  // fail closed before the fetch — a spend we can't record must not be forwarded.
  kv.get = async () => null; // rl:* and global:* both read as 0
  kv.put = async (key) => {
    if (typeof key === "string" && key.startsWith("global:")) {
      throw new Error("global counter write outage");
    }
    return undefined; // rl:* write succeeds
  };

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 503, "a global-counter KV failure must fail closed with 503");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "a request whose global spend could not be recorded must NOT reach upstream");
});

test("a KV failure on the global counter READ -> 503 and no upstream call", async () => {
  // The per-IP limiter reads/writes fine, but the global counter read throws.
  kv.get = async (key) => {
    if (typeof key === "string" && key.startsWith("global:")) {
      throw new Error("global counter read outage");
    }
    return null; // rl:* -> under the per-IP limit
  };
  kv.put = async () => undefined;

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 503, "a global-counter read failure must fail closed with 503");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "an unreadable global counter must NOT be treated as headroom");
});

test("a rejected-model request does NOT increment the global counter", async () => {
  // Everything reads as 0 (under both limits). The request carries a model
  // outside ALLOWED_MODELS, so it must be rejected with 400 BEFORE any global
  // budget is consumed — no `global:` write may occur.
  const globalWrites = [];
  kv.get = async () => null;
  kv.put = async (key, value) => {
    if (typeof key === "string" && key.startsWith("global:")) {
      globalWrites.push(value);
    }
    return undefined;
  };

  const res = await worker.fetch(
    chatRequest({
      model: "claude-sonnet-4-6", // not on this env's allowlist
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 400, "a disallowed model must be rejected with 400");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "a disallowed model must NOT reach upstream");
  assert.equal(
    globalWrites.length,
    0,
    "a request rejected before upstream must NOT consume global budget"
  );
});
