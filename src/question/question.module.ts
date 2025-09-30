import { Module } from '@nestjs/common';
import { QuestionsService } from './question.service';
import { QuestionsController } from './question.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [QuestionsController],
  providers: [QuestionsService],
  exports: [QuestionsService],
})
export class QuestionsModule {}