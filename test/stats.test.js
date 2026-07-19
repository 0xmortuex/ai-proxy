"use strict";

// Drives the REAL compiled worker handler (dist-test/index.js) to prove the
// usage-tracking behavior: stats writes are best-effort (never break a request)
// and GET /stats is gated on X-Stats-Token, returning 404 when it doesn't match.
//
// As in fail-closed.test.js, loadConfig() caches its Config once per process, so
// every test shares one env/kv reference and mutates only the kv method bodies.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../dist-test/index.js").default;

const ALLOWED_ORIGIN = "https://allowed.example.com";
const UPSTREAM_URL = "https://upstream.example.test/v1/messages";
const STATS_TOKEN = "s3cr3t-stats-token";

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
  RATE_LIMIT_MAX: "20",
  UPSTREAM_AUTH_SCHEME: "x-api-key",
  UPSTREAM_TIMEOUT_MS: "60000",
  STATS_TOKEN,
};

let fetchImpl = async () => {
  throw new Error("upstream fetch must not be called in this test");
};

beforeEach(() => {
  // Reset to sane defaults; individual tests override as needed.
  kv.get = async () => null;
  kv.put = async () => undefined;
  globalThis.fetch = async (...args) => fetchImpl(...args);
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
      "CF-Connecting-IP": "203.0.113.9",
    },
    body: validBody,
  });
}

function statsRequest(headers) {
  return new Request("https://proxy.example.test/stats", {
    method: "GET",
    headers: headers ?? {},
  });
}

test("a stats WRITE failure does not change the response status", async () => {
  // Rate-limit read/write succeed; only the stats write (key stats:*) throws.
  kv.get = async () => null;
  kv.put = async (key) => {
    if (typeof key === "string" && key.startsWith("stats:")) {
      throw new Error("stats write outage");
    }
    return undefined;
  };
  fetchImpl = async () =>
    new Response(JSON.stringify({ id: "msg_ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const res = await worker.fetch(chatRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 200, "a stats write failure must not change the status");
  assert.equal(body.ok, true);
  assert.equal(body.data.id, "msg_ok");
});

test("GET /stats with a valid token returns 200 and the counter window", async () => {
  const res = await worker.fetch(
    statsRequest({ "X-Stats-Token": STATS_TOKEN }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.data.days), "data.days must be an array");
  assert.equal(body.data.days.length, 14, "returns the last 14 days");
});

test("GET /stats with a wrong token returns 404", async () => {
  const res = await worker.fetch(
    statsRequest({ "X-Stats-Token": "wrong-token" }),
    env
  );
  const body = await res.json();

  assert.equal(res.status, 404, "a wrong token must be indistinguishable from an unknown path");
  assert.equal(body.ok, false);
});

test("GET /stats with no token returns 404", async () => {
  const res = await worker.fetch(statsRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 404, "a missing token must not reveal the endpoint");
  assert.equal(body.ok, false);
});
