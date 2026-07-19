# ai-proxy

A Cloudflare Worker that sits between your static frontends (GitHub Pages demos) and an AI API. The Worker holds the API key as a Cloudflare secret and injects it server-side, so no key ever ships in client code or gets pasted in by visitors.

## What it does

- **`POST /v1/chat`** — validates the JSON body with zod, forwards it to the upstream AI API with the secret key injected, and returns the upstream response as `{ "ok": true, "data": ... }`.
- **Streaming** — if the request body sets `"stream": true`, the upstream response body is piped straight through without buffering (SSE works end to end).
- **Rate limiting** — fixed window of `RATE_LIMIT_MAX` requests per hour per client IP (from `CF-Connecting-IP`), counted in Workers KV. Exceeding it returns `429` with a `Retry-After` header. If KV itself is unreachable the Worker **fails closed** (`503`) rather than forwarding an unmetered request.
- **Origin allowlist** — requests whose `Origin` header is not in `ALLOWED_ORIGINS` get `403`. CORS preflights echo only the matching allowed origin, never `*`. Note: requests **without** an `Origin` header (curl, server-side scripts) are also rejected — send an `Origin` header when testing.
- **Size cap** — bodies over 100 KB are rejected with `413` before anything is forwarded.
- **`GET /health`** — returns `200` with a small status object. Not rate limited, not origin-checked.

All error responses are `{ "ok": false, "error": "<generic message>" }`. Details go to `console.error` only (visible via `wrangler tail`). The API key is never logged and never appears in any response.

## Setup

### 1. Install dependencies

```sh
npm install
```

This is also all you need to run the tests — `npm test` runs under plain Node and does **not** require wrangler or workerd.

### 2. Configure `wrangler.toml`

| Var | Meaning | Default |
| --- | --- | --- |
| `UPSTREAM_URL` | Full URL of the upstream chat endpoint | Anthropic Messages API |
| `UPSTREAM_AUTH_SCHEME` | `x-api-key` (Anthropic) or `bearer` (OpenAI-compatible) | `x-api-key` |
| `ALLOWED_ORIGINS` | Comma-separated exact origins, e.g. `https://you.github.io,https://demo.example.com` | — |
| `RATE_LIMIT_MAX` | Requests per hour per IP | `20` |
| `UPSTREAM_TIMEOUT_MS` | Upstream timeout in ms (time-to-headers for streams) | `60000` |

An origin is scheme + host + port only (`https://you.github.io`), no path — all your project pages under one GitHub Pages domain share a single origin.

The upstream API key is **not** configured here — it is a Worker secret, set during [Deploy](#deploy).

## Deploy

> **Local `wrangler dev` and `wrangler deploy` do not work under Termux/proot on Android ARM64.** They run `workerd` and `esbuild`, which are native binaries: on this platform `workerd`'s allocator aborts (`tcmalloc … FATAL ERROR: Out of memory … TCMalloc assumes a 48-bit virtual address space`) and `esbuild` deadlocks. This repo therefore deploys from **GitHub Actions**. On a normal Linux/macOS x64/arm64 machine wrangler runs fine, and you can deploy directly with `wrangler deploy` instead of using CI.

Deployment runs from `.github/workflows/deploy.yml` on every push to `main` (and manually via **Actions → Deploy Worker → Run workflow**). The job installs deps, runs `npm test`, and deploys with `cloudflare/wrangler-action` **only if the tests pass**.

### 1. Create a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → use the "Edit Cloudflare Workers" template**. That template carries the Workers Scripts + Workers KV permissions wrangler needs to deploy. Copy the token now — Cloudflare shows it only once.

### 2. Add the GitHub repository secrets

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**. Add both:

| Repository secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID — Cloudflare dashboard sidebar, or `wrangler whoami` on a capable machine |

### 3. Create the KV namespace and set its id

One-time, from a machine that can run wrangler (any normal x64/arm64 Linux/macOS host) **or** the dashboard:

```sh
wrangler kv namespace create RATE_LIMIT
```

Copy the printed `id` into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`, then commit and push. (Dashboard equivalent: **Workers & Pages → KV → Create a namespace**, then paste the id.) **CI deploys fail until this id is a real namespace id.**

### 4. Set the upstream API key secret

The API key is a Worker **secret** — never a repository secret, never a `wrangler.toml` var, never in client code. Set it once from a capable machine:

```sh
wrangler secret put UPSTREAM_API_KEY
```

…or in the dashboard: **Workers & Pages → your Worker → Settings → Variables and Secrets → add `UPSTREAM_API_KEY` as an encrypted secret**. It is stored on Cloudflare, persists across deploys, and CI never sees it.

**Ordering:** the dashboard path needs the Worker to exist first. If you have no capable machine, let CI deploy once (the Worker will return `500 "Service misconfigured"` until the key is present), then add the secret in the dashboard — the next request works. No redeploy is needed for a secret change.

### 5. Push to deploy

Push to `main`, or run the workflow manually from the **Actions** tab. Wrangler prints the Worker URL in the job log, e.g. `https://ai-proxy.<your-subdomain>.workers.dev`.

After deploying, run the [smoke test](scripts/smoke-test.sh) against that URL.

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
- If the KV lookup or write errors, the proxy **fails closed** (`503` + `Retry-After`, logs the error) so a KV outage never silently removes the only spend control on the key.
- `Origin` headers can be forged by non-browser clients; the allowlist stops other websites from using your proxy from browsers, while the rate limit bounds abuse from scripts.
