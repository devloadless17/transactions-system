import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import {
  type CompanyBalance,
  type CompanyListResponse,
  type CompanyResponse,
  type CompanyStatus,
  type CreateCompanyInput,
  type CreateCompanyResponse,
  type ListCompaniesQuery,
  type UpdateCompanyInput,
  UserRole,
  UserStatus,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { expand } from '../commissions/commissions.service';
import type { Prisma } from '@app/db';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(input: CreateCompanyInput): Promise<CreateCompanyResponse> {
    const result = await this.prisma.runAsAdmin(async (tx) => {
      const slugTaken = await tx.company.findUnique({ where: { slug: input.slug } });
      if (slugTaken) throw new ConflictError(`Slug '${input.slug}' is already in use`);

      const emailTaken = await tx.user.findUnique({
        where: { email: input.ownerEmail.toLowerCase() },
      });
      if (emailTaken) throw new ConflictError(`Email '${input.ownerEmail}' is already in use`);

      const tempPassword = generateTempPassword();
      const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });

      const company = await tx.company.create({
        data: {
          name: input.name,
          slug: input.slug,
          defaultCurrency: input.defaultCurrency,
          status: 'ACTIVE',
        },
      });

      const owner = await tx.user.create({
        data: {
          email: input.ownerEmail.toLowerCase(),
          passwordHash,
          role: UserRole.COMPANY_OWNER,
          status: UserStatus.ACTIVE,
          companyId: company.id,
          mustChangePassword: true,
        },
      });

      // Seed a wallet in the company's default currency so balance reads
      // immediately have a row to look at.
      await tx.wallet.create({
        data: {
          companyId: company.id,
          currency: input.defaultCurrency,
        },
      });

      // Optional starter commission rule, created in the SAME transaction so the
      // company is never left unpriced (the whole create rolls back together if
      // anything fails). The new company's id is injected as the rule's scope.
      if (input.commission) {
        await tx.commissionRule.createMany({
          data: expand(crypto.randomUUID(), { ...input.commission, companyIds: [company.id] }),
        });
        this.logger.log(`Seeded starter commission rule for company ${company.id}`);
      }

      this.logger.log(`Created company ${company.slug} (${company.id}) with owner ${owner.email}`);

      return {
        company: mapCompany(company),
        owner: {
          id: owner.id,
          email: owner.email,
          temporaryPassword: tempPassword,
        },
      };
    });
    this.realtime.admin(['companies'], result.company.id);
    return result;
  }

  /**
   * `includeBalances` is an AUTHORIZATION gate, not a display toggle: only a
   * SUPER_ADMIN may see how much money each tenant holds. When false we never
   * even query the wallets, so the figures cannot leak through the response.
   */
  async list(
    query: ListCompaniesQuery,
    opts: { includeBalances: boolean } = { includeBalances: false },
  ): Promise<CompanyListResponse> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.CompanyWhereInput = {};
      if (query.status) where.status = query.status;
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search.toLowerCase() } },
        ];
      }
      // Targeted lookup: resolve a specific set of companies (e.g. the ones on
      // the current page of an admin list) without scanning the whole table.
      const idList = query.ids
        ?.split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
      if (idList?.length) where.id = { in: idList };
      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
      const [rows, total, totalsByCurrency] = await Promise.all([
        tx.company.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
        }),
        tx.company.count({ where }),
        // Platform float: available balance per currency across EVERY company
        // matching the query — not just this page — so the admin's "total" is a
        // real total rather than a page subtotal. Mirrors the groupBy in
        // platform-analytics.service.ts.
        opts.includeBalances
          ? tx.wallet.groupBy({
              by: ['currency'],
              where: { company: where },
              _sum: { availableBalance: true },
            })
          : Promise.resolve([]),
      ]);

      if (!opts.includeBalances) {
        return {
          data: rows.map(mapCompany),
          meta: {
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
          },
        };
      }

      // One batched query for the page's balances — never one lookup per row.
      // Served by the wallets (company_id, currency) unique index.
      const walletRows = rows.length
        ? await tx.wallet.groupBy({
            by: ['companyId', 'currency'],
            where: { companyId: { in: rows.map((r) => r.id) } },
            _sum: { availableBalance: true },
          })
        : [];

      const byCompany = new Map<string, CompanyBalance[]>();
      for (const w of walletRows) {
        const list = byCompany.get(w.companyId) ?? [];
        list.push({
          currency: w.currency.trim(),
          availableBalance: w._sum.availableBalance?.toString() ?? '0',
        });
        byCompany.set(w.companyId, list);
      }

      return {
        data: rows.map((r) => ({
          ...mapCompany(r),
          // A company with no wallet yet reports an empty list, not a fake zero.
          balances: (byCompany.get(r.id) ?? []).sort((a, b) =>
            a.currency.localeCompare(b.currency),
          ),
        })),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
        totals: totalsByCurrency
          .map((t) => ({
            currency: t.currency.trim(),
            availableBalance: t._sum.availableBalance?.toString() ?? '0',
          }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    });
  }

  async getById(id: string): Promise<CompanyResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.company.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('Company', id);
    return mapCompany(row);
  }

  async update(id: string, input: UpdateCompanyInput): Promise<CompanyResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const existing = await tx.company.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('Company', id);
      return tx.company.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          status: input.status ?? undefined,
          visible: input.visible ?? undefined,
        },
      });
    });
    // Admin-room only: TOPIC_KEYS.companies maps exclusively to admin-app query
    // keys, so a company-room delivery invalidated nothing for company users (a
    // deactivated company learns on its next API call, which 403s). If a company
    // shell ever queries its own profile live, add that key to
    // TOPIC_KEYS.companies and switch this back to realtime.company(...).
    this.realtime.admin(['companies'], id);
    return mapCompany(row);
  }

  async disable(id: string): Promise<CompanyResponse> {
    return this.update(id, { status: 'DISABLED' satisfies CompanyStatus });
  }

  async activate(id: string): Promise<CompanyResponse> {
    return this.update(id, { status: 'ACTIVE' satisfies CompanyStatus });
  }
}

function mapCompany(row: {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  visible: boolean;
  defaultCurrency: string;
  createdAt: Date;
  updatedAt: Date;
}): CompanyResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    visible: row.visible,
    defaultCurrency: row.defaultCurrency.trim(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function generateTempPassword(): string {
  // 16 bytes of base64url → ~22 chars. Mixed-case + digits, safe for cookies/logs.
  return crypto.randomBytes(16).toString('base64url');
}
