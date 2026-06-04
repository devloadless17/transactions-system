import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrmConfigService } from './crm-config.service';
import { CrmDispatchService } from './crm-dispatch.service';
import { CrmDeliveryService } from './crm-delivery.service';
import { CrmDemoInboxService } from './crm-demo-inbox.service';
import { CrmController } from './crm.controller';
import { CrmDemoController } from './crm-demo.controller';

/**
 * CRM integration: outbound POST of every transaction's status lifecycle to a
 * company's own CRM (durable, retried), plus a built-in live demo inbox preview.
 * `CrmDispatchService` is the entry point the transactions + whish modules call.
 */
@Module({
  imports: [AuthModule],
  controllers: [CrmController, CrmDemoController],
  providers: [CrmConfigService, CrmDispatchService, CrmDeliveryService, CrmDemoInboxService],
  exports: [CrmDispatchService],
})
export class CrmModule {}
