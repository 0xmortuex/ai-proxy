import { z } from "zod";

/**
 * Minimal shape shared by chat-style AI APIs (Anthropic Messages,
 * OpenAI-compatible chat completions). Unknown fields pass through
 * so provider-specific options reach the upstream unchanged.
 */
export const chatRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    stream: z.boolean().optional(),
    messages: z
      .array(
        z
          .object({
            role: z.string().min(1),
            content: z.unknown(),
          })
          .passthrough()
      )
      .min(1),
  })
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
