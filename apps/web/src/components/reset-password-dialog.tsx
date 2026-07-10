'use client';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import type { InviteTeamMemberResponse, TeamMemberResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

/**
 * Confirm → reset → reveal-once dialog, shared by the admin company-users card
 * and the company team page (they differ only in the endpoint).
 *
 * The temporary password is returned by the API exactly ONCE. Closing the dialog
 * mid-flight would still complete the reset server-side — rotating the hash and
 * revoking every session — while discarding the only copy of the new credential,
 * locking the user out with a password nobody knows. So while the mutation is in
 * flight the dialog refuses to close: Cancel is disabled and `onOpenChange`
 * (ESC / outside-click) is ignored.
 */
export function ResetPasswordDialog({
  target,
  endpoint,
  onClose,
  onReset,
}: {
  target: TeamMemberResponse | null;
  /** Full API path, e.g. `/company/team/${id}/reset-password`. */
  endpoint: (target: TeamMemberResponse) => string;
  onClose: () => void;
  onReset?: () => void;
}) {
  const [result, setResult] = useState<InviteTeamMemberResponse | null>(null);

  const mu = useMutation({
    mutationFn: () => apiFetch<InviteTeamMemberResponse>(endpoint(target!), { method: 'POST' }),
    onSuccess: (res) => {
      setResult(res);
      onReset?.();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function handleOpenChange(open: boolean) {
    if (open) return;
    // The reset is already on the wire — closing now would throw away the only
    // copy of the new password.
    if (mu.isPending) return;
    setResult(null);
    onClose();
  }

  return (
    <Dialog open={!!target} onOpenChange={handleOpenChange}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Temporary password</DialogTitle>
              <DialogDescription>
                Share this one-time password with {result.member.email}. It is shown only once and
                must be changed on their next login.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
              {result.temporaryPassword}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(result.temporaryPassword);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Reset password?</DialogTitle>
              <DialogDescription>
                {target?.email} will get a new one-time temporary password and be signed out of all
                sessions. They must set a new password on their next login.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={mu.isPending}
              >
                Cancel
              </Button>
              <Button onClick={() => mu.mutate()} disabled={mu.isPending}>
                {mu.isPending ? 'Resetting…' : 'Reset password'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
