import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { CrmModule } from '../crm/crm.module';
import { WhishClient } from './whish.client';
import { WhishPaymentsService } from './whish-payments.service';
import { WhishWebhookService } from './whish-webhook.service';
import { WhishReconciliationService } from './whish-reconciliation.service';
import { WhishPaymentsController } from './whish-payments.controller';
import { WhishCallbackController } from './whish-callback.controller';
import { WhishAdminController } from './whish-admin.controller';
import { WhishWebhookController } from './whish-webhook.controller';
import { WhishConfigController } from './whish-config.controller';
import { WhishRedirectController } from './whish-redirect.controller';
import { IntegrationsWhishController } from './integrations-whish.controller';

@Module({
  imports: [AuthModule, TransactionsModule, ApiKeysModule, CommissionsModule, CrmModule],
  controllers: [
    WhishPaymentsController,
    WhishCallbackController,
    WhishAdminController,
    WhishWebhookController,
    WhishConfigController,
    WhishRedirectController,
    IntegrationsWhishController,
  ],
  providers: [WhishClient, WhishPaymentsService, WhishWebhookService, WhishReconciliationService],
  exports: [WhishClient, WhishPaymentsService],
})
export class WhishModule {}
