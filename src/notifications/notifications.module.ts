import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsService } from './notifications.service';
import { NotificationsWorker } from './notifications.worker';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, forwardRef(() => TelegramModule)],
  providers: [NotificationsService, NotificationsWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}