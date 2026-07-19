import { z } from "zod";

/**
 * Explicit shape for a chat request. Only the fields we care about are allowed;
 * unknown top-level keys are rejected (`.strict()`) so callers can't smuggle
 * extra upstream options past this boundary. `model` and `max_tokens` are
 * required — we never let the upstream default apply. Allowlist and ceiling
 * checks for those two values live in the handler, since they depend on config.
 *
 * `messages` stays permissive: `content` is left as unknown so text and
 * document content blocks (e.g. PDF `document` blocks) pass through unchanged.
 */
const messageSchema = z
  .object({
    role: z.string().min(1),
    content: z.unknown(),
  })
  .passthrough();

export const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    system: z.unknown().optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
