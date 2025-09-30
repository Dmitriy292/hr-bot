import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './prisma/prisma.module';
import { QuestionsModule } from './question/question.module';
import { TelegramModule } from './telegram/telegram.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    forwardRef(() => NotificationsModule),
    QuestionsModule,
    forwardRef(() => TelegramModule),
  ],
})
export class AppModule {}