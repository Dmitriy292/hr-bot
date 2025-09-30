import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscribersService {
  constructor(private prisma: PrismaService) {}

  async add(chatId: number | string): Promise<void> {
    const id = String(chatId);
    await this.prisma.subscriber.upsert({
      where: { chatId: id },
      update: {},
      create: { chatId: id },
    });
  }

  async allChatIds(): Promise<string[]> {
    const rows = await this.prisma.subscriber.findMany({
      select: { chatId: true },
    });
    // Явно указываем тип для r, чтобы не было TS7006
    return rows.map((r: { chatId: string }) => r.chatId);
  }
}
