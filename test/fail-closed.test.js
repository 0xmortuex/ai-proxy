"use strict";

// Proves the fail-closed rate limiter against the REAL worker handler.
// We import the compiled handler (dist-test/index.js) and drive it with a fake
// `env` and a mocked global `fetch`; no real network call is ever made.
//
// KV behavior is varied per test by mutating a single shared `kv` object's
// methods. This matters because loadConfig() caches its Config (including the
// KV binding) once per process, so every test must share the same env/kv
// reference and change only the method bodies.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../dist-test/index.js").default;

const ALLOWED_ORIGIN = "https://allowed.example.com";
const UPSTREAM_URL = "https://upstream.example.test/v1/messages";

// Shared KV double. Each test rewrites .get / .put to model the scenario.
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
  UPSTREAM_AUTH_SCHEME: "x-api-key",
  UPSTREAM_TIMEOUT_MS: "60000",
  STATS_TOKEN: "test-stats-token",
};

// Mocked upstream. fetchCalls counts how many times the handler hit the network.
let fetchCalls = 0;
let fetchImpl = async () => {
  throw new Error("upstream fetch must not be called in this test");
};

beforeEach(() => {
  fetchCalls = 0;
  // The handler calls the bare global `fetch`; replace it so nothing leaves the box.
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };
});

const validBody = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
});

function chatRequest() {
  return new Request("https://proxy.example.test/v1/chat", {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
    },
    body: validBody,
  });
}

function healthRequest() {
  return new Request("https://proxy.example.test/health", { method: "GET" });
}

test("KV READ rejects -> 503 and upstream is never called", async () => {
  kv.get = async () => {
    throw new Error("KV read outage");
  };
  kv.put = async () => undefined;

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 503, "KV read failure must fail closed with 503");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "request must NOT reach upstream when the counter could not be read");
});

test("KV WRITE rejects (after a successful read) -> 503 and upstream is never called", async () => {
  kv.get = async () => null; // read succeeds, count = 0
  kv.put = async () => {
    throw new Error("KV write outage");
  };

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 503, "KV write failure must fail closed with 503");
  assert.equal(body.ok, false);
  assert.equal(fetchCalls, 0, "a request whose usage was never recorded must NOT reach upstream");
});

test("GET /health still returns 200 while KV is failing", async () => {
  kv.get = async () => {
    throw new Error("KV read outage");
  };
  kv.put = async () => {
    throw new Error("KV write outage");
  };

  const res = await worker.fetch(healthRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 200, "/health is not rate limited and must survive a KV outage");
  assert.equal(body.ok, true);
});

test("normal request under the limit -> 200 and DOES reach upstream", async () => {
  kv.get = async () => null; // count 0, under the limit
  kv.put = async () => undefined; // write succeeds
  fetchImpl = async () =>
    new Response(JSON.stringify({ id: "msg_ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.id, "msg_ok");
  assert.equal(fetchCalls, 1, "a permitted request must be forwarded upstream exactly once");
});
