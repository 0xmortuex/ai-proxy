import type { ApiResponse } from "../types/api";

export function jsonResponse<T>(
  status: number,
  body: ApiResponse<T>,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

export function jsonOk<T>(data: T, extraHeaders?: HeadersInit): Response {
  return jsonResponse(200, { ok: true, data }, extraHeaders);
}

export function jsonError(
  status: number,
  error: string,
  extraHeaders?: HeadersInit
): Response {
  return jsonResponse(status, { ok: false, error }, extraHeaders);
}

export type BodyReadResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too-large" };

/**
 * Reads the request body without ever buffering more than maxBytes,
 * so oversized (or chunked, length-less) uploads are cut off early.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number
): Promise<BodyReadResult> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maxBytes) {
      return { kind: "too-large" };
    }
  }

  if (request.body === null) {
    return { kind: "ok", bytes: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: "too-large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}
