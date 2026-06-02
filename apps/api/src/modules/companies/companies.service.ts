import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import {
  type CompanyResponse,
  type CompanyStatus,
  type CreateCompanyInput,
  type CreateCompanyResponse,
  type ListCompaniesQuery,
  type PaginatedResponse,
  type UpdateCompanyInput,
  UserRole,
  UserStatus,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';
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

  async list(query: ListCompaniesQuery): Promise<PaginatedResponse<CompanyResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.CompanyWhereInput = {};
      if (query.status) where.status = query.status;
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search.toLowerCase() } },
        ];
      }
      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.company.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
        }),
        tx.company.count({ where }),
      ]);
      return {
        data: rows.map(mapCompany),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
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
    // Status/visibility flips must reach the company's own users too (e.g. a
    // deactivated company should see access change), not just admins.
    this.realtime.company(id, ['companies']);
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
