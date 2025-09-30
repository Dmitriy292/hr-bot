import { Module, forwardRef } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { QuestionsModule } from '../question/question.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscribersModule } from '../subscribers/subscribers.module';

@Module({
  imports: [
    ConfigModule,
    QuestionsModule,
    PrismaModule,
    SubscribersModule,                // 👈 добавили
    forwardRef(() => NotificationsModule),
  ],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
