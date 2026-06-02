import { PrismaService } from '../database/prisma.service';
import { ForbiddenError } from './errors/domain.error';

/**
 * Gate every authenticated entry point on the tenant's company being ACTIVE.
 *
 * A SUPER_ADMIN can flip a company to a non-ACTIVE status (SUSPENDED/DISABLED)
 * to freeze it: the row and all its data are retained (this is a transaction
 * system — nothing is ever deleted), but the company can no longer log in,
 * call the API, ingest, or receive anything. Re-activating restores access.
 *
 * Callers with no companyId (SUPER_ADMIN / ADMIN_OPERATOR) are platform-level
 * and are never gated here.
 */
export async function assertCompanyActive(
  prisma: PrismaService,
  companyId: string | null | undefined,
): Promise<void> {
  if (!companyId) return;
  const company = await prisma.runAsAdmin((tx) =>
    tx.company.findUnique({ where: { id: companyId }, select: { status: true } }),
  );
  if (!company || company.status !== 'ACTIVE') {
    throw new ForbiddenError('This company is inactive. Contact your administrator.');
  }
}

/**
 * Gate source-key entry points on the source being ACTIVE. A SUPER_ADMIN can
 * flip a source to INACTIVE to stop working with that provider: its keys stop
 * authenticating and it disappears from discovery, while its history is kept.
 */
export async function assertSourceActive(
  prisma: PrismaService,
  sourceId: string | null | undefined,
): Promise<void> {
  if (!sourceId) return;
  const source = await prisma.runAsAdmin((tx) =>
    tx.source.findUnique({ where: { id: sourceId }, select: { status: true } }),
  );
  if (!source || source.status !== 'ACTIVE') {
    throw new ForbiddenError('This source is inactive.');
  }
}
