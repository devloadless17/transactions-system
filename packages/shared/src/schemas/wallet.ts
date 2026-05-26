import { z } from 'zod';

export const walletResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  currency: z.string(),
  availableBalance: z.string(),
  pendingBalance: z.string(),
  reservedBalance: z.string(),
  updatedAt: z.string(),
});
export type WalletResponse = z.infer<typeof walletResponseSchema>;
