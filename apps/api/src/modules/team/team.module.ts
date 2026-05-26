import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';

@Module({
  imports: [AuthModule],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
