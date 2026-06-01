import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';
import { AdminCompanyUsersController } from './admin-company-users.controller';

@Module({
  imports: [AuthModule],
  controllers: [TeamController, AdminCompanyUsersController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
