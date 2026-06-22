import { z } from 'zod';
import { NotificationEvent, NotificationFlow, NotificationScope } from '../enums';

// A single in-app notification. `title`/`body`/`link` are computed when the
// notification is created so the client just renders them; `flow`/`event` drive
// the icon + accent colour, and `read` is per-user.
export const notificationResponseSchema = z.object({
  id: z.string().uuid(),
  scope: z.nativeEnum(NotificationScope),
  flow: z.nativeEnum(NotificationFlow),
  event: z.nativeEnum(NotificationEvent),
  title: z.string(),
  body: z.string(),
  // In-app path to open when clicked (e.g. /admin/payouts, /app/withdrawals).
  link: z.string(),
  // The operation this notification is about (withdrawal/payout/load id).
  entityId: z.string().uuid().nullable(),
  // Subject company name, shown on admin rows (kept out of the RLS column).
  companyName: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  // active = not cleared (default, the bell + main list); unread = never seen;
  // cleared = dismissed, kept for review.
  filter: z.enum(['active', 'unread', 'cleared']).default('active'),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

// Paginated notifications plus the unread total for the bell badge.
export type NotificationListResponse = {
  data: NotificationResponse[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  unreadCount: number;
};
