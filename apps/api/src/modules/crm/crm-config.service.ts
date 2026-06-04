import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import type { CrmConfigResponse, SetCrmConfigInput } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { assertSafeWebhookUrl } from '../../common/net/ssrf';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Company-managed CRM integration config. The API key is the credential the
 * company's CRM expects in the Authorization header — we store it so we can
 * send it on every POST, but never return it (only `hasApiKey`).
 */
@Injectable()
export class CrmConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly realtime: RealtimeService,
  ) {}

  async getConfig(companyId: string): Promise<CrmConfigResponse> {
    const c = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { crmApiUrl: true, crmApiKey: true, crmEnabled: true, crmDemoToken: true },
      }),
    );
    return {
      apiUrl: c?.crmApiUrl ?? null,
      hasApiKey: !!c?.crmApiKey,
      enabled: !!c?.crmEnabled,
      demoUrl: c?.crmDemoToken ? this.demoUrl(c.crmDemoToken) : null,
    };
  }

  /** Point the integration at the company's own CRM (real, external). */
  async setConfig(companyId: string, input: SetCrmConfigInput): Promise<CrmConfigResponse> {
    // Reject https-only / private-address violations up front (400).
    await assertSafeWebhookUrl(input.apiUrl);
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { crmApiUrl: input.apiUrl, crmApiKey: input.apiKey, crmEnabled: true },
      }),
    );
    this.realtime.company(companyId, ['crm']);
    return this.getConfig(companyId);
  }

  async clear(companyId: string): Promise<CrmConfigResponse> {
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { crmApiUrl: null, crmApiKey: null, crmEnabled: false },
      }),
    );
    this.realtime.company(companyId, ['crm']);
    return this.getConfig(companyId);
  }

  /**
   * Point the integration at the built-in demo CRM inbox so the company can
   * preview the flow end-to-end. Generates a stable token + key once and wires
   * the config to the first-party demo URL (which delivery captures in-process,
   * bypassing the external SSRF/https requirement).
   */
  async enableDemo(companyId: string): Promise<CrmConfigResponse> {
    const existing = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { crmDemoToken: true, crmDemoKey: true },
      }),
    );
    const token = existing?.crmDemoToken ?? crypto.randomBytes(16).toString('hex');
    const key = existing?.crmDemoKey ?? `crmdemo_${crypto.randomBytes(24).toString('hex')}`;
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: {
          crmDemoToken: token,
          crmDemoKey: key,
          crmApiUrl: this.demoUrl(token),
          crmApiKey: key,
          crmEnabled: true,
        },
      }),
    );
    this.realtime.company(companyId, ['crm']);
    return this.getConfig(companyId);
  }

  private demoUrl(token: string): string {
    const base = this.config.get('API_PUBLIC_URL', { infer: true });
    return `${base}/crm-demo/${token}/inbox`;
  }
}
