"use strict";

// Drives the REAL compiled worker handler (dist-test/index.js) to prove the
// request-shaping limits: a model outside ALLOWED_MODELS, a max_tokens above
// MAX_OUTPUT_TOKENS, and a request missing a required field are all rejected
// with 400 before anything is forwarded upstream. Model/token rejections are
// also recorded under the "rejected" stats bucket.
//
// As in the other suites, loadConfig() caches its Config once per process, so
// every test shares one env/kv reference and mutates only the kv method bodies.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../dist-test/index.js").default;

const ALLOWED_ORIGIN = "https://allowed.example.com";
const UPSTREAM_URL = "https://upstream.example.test/v1/messages";

// Shared KV double. Rate-limit reads/writes succeed so requests reach validation.
const kv = {
  get: async () => null,
  put: async () => undefined,
};

const env = {
  RATE_LIMIT: kv,
  UPSTREAM_URL,
  UPSTREAM_API_KEY: "test-secret-key",
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  ALLOWED_MODELS: "claude-sonnet-4-6",
  MAX_OUTPUT_TOKENS: "2048",
  RATE_LIMIT_MAX: "20",
  UPSTREAM_AUTH_SCHEME: "x-api-key",
  UPSTREAM_TIMEOUT_MS: "60000",
  STATS_TOKEN: "test-stats-token",
};

// Any upstream call is a bug: a rejected request must never be forwarded.
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  kv.get = async () => null;
  kv.put = async () => undefined;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("upstream fetch must not be called for a rejected request");
  };
});

function chatRequest(body) {
  return new Request("https://proxy.example.test/v1/chat", {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.11",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a model outside the allowlist is rejected with 400 and never forwarded", async () => {
  const statsWrites = [];
  kv.put = async (key, value) => {
    if (typeof key === "string" && key.startsWith("stats:")) {
      statsWrites.push(value);
    }
    return undefined;
  };

  const res = await worker.fetch(
    chatRequest({
      model: "claude-opus-4-8", // not on the allowlist
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 400, "a disallowed model must be rejected with 400");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "a disallowed model must NOT reach upstream");
  assert.ok(
    statsWrites.some((value) => JSON.parse(value).rejected === 1),
    "a model rejection must bump the rejected counter"
  );
});

test("a max_tokens above the ceiling is rejected with 400 and never forwarded", async () => {
  const statsWrites = [];
  kv.put = async (key, value) => {
    if (typeof key === "string" && key.startsWith("stats:")) {
      statsWrites.push(value);
    }
    return undefined;
  };

  const res = await worker.fetch(
    chatRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 999999, // over MAX_OUTPUT_TOKENS
      messages: [{ role: "user", content: "hi" }],
    }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 400, "an over-ceiling max_tokens must be rejected, not clamped");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "an over-ceiling request must NOT reach upstream");
  assert.ok(
    statsWrites.some((value) => JSON.parse(value).rejected === 1),
    "a token-ceiling rejection must bump the rejected counter"
  );
});

test("a request missing max_tokens is rejected with 400 and never forwarded", async () => {
  const res = await worker.fetch(
    chatRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 400, "a missing required field must be rejected with 400");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "a malformed request must NOT reach upstream");
});
