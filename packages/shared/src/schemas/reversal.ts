import { z } from 'zod';

export const reverseTransactionSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type ReverseTransactionInput = z.infer<typeof reverseTransactionSchema>;
