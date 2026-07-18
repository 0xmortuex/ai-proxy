# ai-proxy

A Cloudflare Worker that sits between your static frontends (GitHub Pages demos) and an AI API. The Worker holds the API key as a Cloudflare secret and injects it server-side, so no key ever ships in client code or gets pasted in by visitors.

## What it does

- **`POST /v1/chat`** — validates the JSON body with zod, forwards it to the upstream AI API with the secret key injected, and returns the upstream response as `{ "ok": true, "data": ... }`.
- **Streaming** — if the request body sets `"stream": true`, the upstream response body is piped straight through without buffering (SSE works end to end).
- **Rate limiting** — fixed window of `RATE_LIMIT_MAX` requests per hour per client IP (from `CF-Connecting-IP`), counted in Workers KV. Exceeding it returns `429` with a `Retry-After` header.
- **Origin allowlist** — requests whose `Origin` header is not in `ALLOWED_ORIGINS` get `403`. CORS preflights echo only the matching allowed origin, never `*`. Note: requests **without** an `Origin` header (curl, server-side scripts) are also rejected — send an `Origin` header when testing.
- **Size cap** — bodies over 100 KB are rejected with `413` before anything is forwarded.
- **`GET /health`** — returns `200` with a small status object. Not rate limited, not origin-checked.

All error responses are `{ "ok": false, "error": "<generic message>" }`. Details go to `console.error` only (visible via `wrangler tail`). The API key is never logged and never appears in any response.

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Create the KV namespace

```sh
wrangler kv namespace create RATE_LIMIT
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Configure `wrangler.toml`

| Var | Meaning | Default |
| --- | --- | --- |
| `UPSTREAM_URL` | Full URL of the upstream chat endpoint | Anthropic Messages API |
| `UPSTREAM_AUTH_SCHEME` | `x-api-key` (Anthropic) or `bearer` (OpenAI-compatible) | `x-api-key` |
| `ALLOWED_ORIGINS` | Comma-separated exact origins, e.g. `https://you.github.io,https://demo.example.com` | — |
| `RATE_LIMIT_MAX` | Requests per hour per IP | `20` |
| `UPSTREAM_TIMEOUT_MS` | Upstream timeout in ms (time-to-headers for streams) | `60000` |

An origin is scheme + host + port only (`https://you.github.io`), no path — all your project pages under one GitHub Pages domain share a single origin.

### 4. Set the secret

```sh
wrangler secret put UPSTREAM_API_KEY
```

Paste your AI API key when prompted. For local development, put it in a `.dev.vars` file instead (gitignored):

```
UPSTREAM_API_KEY=sk-...
```

### 5. Deploy

```sh
wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://ai-proxy.<your-subdomain>.workers.dev`.

## Calling it from a static frontend

```js
const PROXY_URL = "https://ai-proxy.YOUR-SUBDOMAIN.workers.dev/v1/chat";

// --- Non-streaming ---
async function chat(userText) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(payload.error);
  return payload.data; // the upstream API's response object
}

// --- Streaming (SSE passed straight through) ---
async function chatStream(userText, onChunk) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) {
    const payload = await res.json();
    throw new Error(payload.error);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true })); // raw SSE text from the upstream
  }
}
```

The request body is forwarded to the upstream as-is (with the key injected), so use whatever fields your upstream API expects — the proxy only requires a non-empty `messages` array and treats `stream: true` as the signal to pipe.

## Notes

- Rate limit counters live in KV, which is eventually consistent — the limit is approximate under rapid bursts from one IP. Good enough for abuse throttling.
- If the KV lookup itself errors, the proxy fails open (logs the error, lets the request through) rather than going down with KV.
- `Origin` headers can be forged by non-browser clients; the allowlist stops other websites from using your proxy from browsers, while the rate limit bounds abuse from scripts.
