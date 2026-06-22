import { toast as sonnerToast } from 'sonner';

// Errors stay on screen longer than the global (success/info) default set on the
// <Toaster> in the root layout — a failed money operation's reason needs to be
// readable, not gone in a couple seconds. Success/info toasts inherit the shorter
// global default. Any call can still override `duration` explicitly.
const ERROR_DURATION_MS = 6000;

/**
 * App-wide toast. Import this instead of `sonner` directly so error toasts get a
 * longer default duration. Same API as sonner's `toast` (`.success`, `.error`,
 * `.message`, …); only `.error`'s default duration differs.
 */
export const toast = {
  ...sonnerToast,
  error: (
    message: Parameters<typeof sonnerToast.error>[0],
    data?: Parameters<typeof sonnerToast.error>[1],
  ) => sonnerToast.error(message, { duration: ERROR_DURATION_MS, ...data }),
};
