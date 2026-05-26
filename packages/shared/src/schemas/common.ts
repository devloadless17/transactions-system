import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../enums';

export const uuidSchema = z.string().uuid();

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });

export type PaginatedResponse<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};
