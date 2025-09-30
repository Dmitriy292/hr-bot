import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscribersService } from './subscribers.service';

@Module({
  imports: [PrismaModule],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}
