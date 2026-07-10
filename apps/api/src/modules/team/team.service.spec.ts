import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain.error';
import { TeamService } from './team.service';

/**
 * `resetPassword` is now reachable by a COMPANY_OWNER, so its authorization
 * boundaries are load-bearing. It runs under `runAsAdmin` (RLS bypassed), which
 * means the `member.companyId !== companyId` check IS the tenant boundary.
 * These tests pin it, plus the self-reset and platform-admin protections.
 */
const OWNER_CO = 'company-1';
const OWNER_ID = 'owner-1';

type UserRow = { id: string; companyId: string | null; role: string; status: string };

function makeService(target: UserRow | null) {
  const update = vi.fn().mockResolvedValue({
    id: target?.id ?? 'x',
    email: 'u@example.com',
    role: target?.role ?? 'COMPANY_MANAGER',
    status: 'ACTIVE',
    companyId: target?.companyId ?? OWNER_CO,
    mustChangePassword: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });
  const refreshUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
  const tx = {
    user: { findUnique: vi.fn().mockResolvedValue(target), update },
    refreshToken: { updateMany: refreshUpdateMany },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const realtime = { company: vi.fn() } as unknown as RealtimeService;
  return { svc: new TeamService(prisma, realtime), tx, update, refreshUpdateMany };
}

const member = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'member-1',
  companyId: OWNER_CO,
  role: 'COMPANY_MANAGER',
  status: 'ACTIVE',
  ...over,
});

describe('TeamService.resetPassword — owner path', () => {
  it('resets a manager in the owner’s own company', async () => {
    const { svc, update, refreshUpdateMany } = makeService(member());
    const res = await svc.resetPassword(OWNER_CO, 'member-1', OWNER_ID);

    expect(res.temporaryPassword).toBeTruthy();
    // Forces rotation on next login…
    expect(update.mock.calls[0][0].data.mustChangePassword).toBe(true);
    // …and kills every live session, so the old credential is worthless.
    expect(refreshUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'member-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('allows resetting a CO-OWNER (explicitly permitted)', async () => {
    const { svc } = makeService(member({ id: 'owner-2', role: 'COMPANY_OWNER' }));
    await expect(svc.resetPassword(OWNER_CO, 'owner-2', OWNER_ID)).resolves.toMatchObject({
      temporaryPassword: expect.any(String),
    });
  });

  it('REFUSES a cross-tenant reset (another company’s user)', async () => {
    const { svc, update } = makeService(member({ companyId: 'company-2' }));
    await expect(svc.resetPassword(OWNER_CO, 'member-1', OWNER_ID)).rejects.toThrow(NotFoundError);
    expect(update).not.toHaveBeenCalled();
  });

  it('REFUSES to reset a platform admin (companyId is NULL)', async () => {
    const { svc, update } = makeService(
      member({ id: 'sa-1', companyId: null, role: 'SUPER_ADMIN' }),
    );
    await expect(svc.resetPassword(OWNER_CO, 'sa-1', OWNER_ID)).rejects.toThrow(NotFoundError);
    expect(update).not.toHaveBeenCalled();
  });

  it('REFUSES a self-reset — that must go through change-password', async () => {
    const { svc, tx } = makeService(member({ id: OWNER_ID, role: 'COMPANY_OWNER' }));
    await expect(svc.resetPassword(OWNER_CO, OWNER_ID, OWNER_ID)).rejects.toThrow(ForbiddenError);
    // Short-circuits before touching the DB at all.
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });

  it('REFUSES when the target does not exist', async () => {
    const { svc } = makeService(null);
    await expect(svc.resetPassword(OWNER_CO, 'ghost', OWNER_ID)).rejects.toThrow(NotFoundError);
  });

  it('issues a fresh, unguessable temp password each time', async () => {
    const a = await makeService(member()).svc.resetPassword(OWNER_CO, 'member-1', OWNER_ID);
    const b = await makeService(member()).svc.resetPassword(OWNER_CO, 'member-1', OWNER_ID);
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
    expect(a.temporaryPassword.length).toBeGreaterThanOrEqual(16);
  });
});

describe('TeamService.resetPassword — admin path is unchanged', () => {
  it('still works without an actorId (platform admin resetting a company user)', async () => {
    const { svc, refreshUpdateMany } = makeService(member());
    await expect(svc.resetPassword(OWNER_CO, 'member-1')).resolves.toMatchObject({
      temporaryPassword: expect.any(String),
    });
    expect(refreshUpdateMany).toHaveBeenCalled();
  });

  it('an admin can reset a user whose id equals nothing in session (no self-guard trip)', async () => {
    const { svc } = makeService(member({ id: OWNER_ID }));
    await expect(svc.resetPassword(OWNER_CO, OWNER_ID)).resolves.toBeTruthy();
  });
});
