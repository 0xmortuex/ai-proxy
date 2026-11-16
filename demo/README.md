# ai-proxy-demo

A single-page test client for the Cloudflare Worker AI proxy at
**https://ai-proxy.mortuexhavoc.workers.dev**.

The Worker exposes `GET /health` and `POST /v1/chat`, forwards chat requests to
the Anthropic Messages API with the API key injected server-side, and returns
`{ ok, data }`. **No API key lives in this page** — it never should.

`index.html` is one self-contained file (no framework, no build step): a prompt
textarea, a non-streaming **Send**, a streaming **Send (stream)**, explicit
loading / success / error states (errors show the real HTTP status and raw
body), and a per-session request counter to track the Worker's 20-requests-per-hour
limit.

## Must be served from GitHub Pages

The Worker enforces an **Origin allowlist** and only accepts requests from
`https://0xmortuex.github.io`. Opening `index.html` from `file://` or
`localhost` will be rejected with **403 Origin not allowed**. Serve it from
GitHub Pages (which puts it on the allowlisted origin) for the calls to succeed.
