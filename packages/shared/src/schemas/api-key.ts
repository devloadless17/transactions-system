import { z } from 'zod';

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(80),
  expiresAt: z.string().datetime().optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const apiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;

export const createApiKeyResponseSchema = z.object({
  apiKey: apiKeyResponseSchema,
  // Plaintext key — only shown once at creation.
  plaintext: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;
