import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { CrmModule } from '../crm/crm.module';
import { WhishModule } from '../whish/whish.module';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';
import { AutoApprovalConfigStore } from './auto-approval-config.store';
import { WithdrawalAutoApprovalService } from './withdrawal-auto-approval.service';

@Module({
  imports: [
    AuthModule,
    ApiKeysModule,
    LedgerModule,
    WalletsModule,
    AnalyticsModule,
    CommissionsModule,
    CrmModule,
    // For the auto-approval processor to send W2W transfers (WhishTransfersService).
    WhishModule,
  ],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService, AutoApprovalConfigStore, WithdrawalAutoApprovalService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
