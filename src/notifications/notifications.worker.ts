import { Injectable, Logger, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class NotificationsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  private intervalMs = Math.max(1000, parseInt(process.env.NOTIFY_INTERVAL_MS || '5000', 10));
  private graceMs = Math.max(0, parseInt(process.env.NOTIFY_GRACE_MS || '0', 10)); // допуск

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegram: TelegramService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.tick().catch(err => this.logger.error('tick error', err)), this.intervalMs);
    this.logger.log(`Notifications worker started (interval=${this.intervalMs}ms, grace=${this.graceMs}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      const due = await this.notifications.dueNotifications(now, this.graceMs);
      if (due.length > 0) this.logger.log(`Sending ${due.length} notifications...`);
      for (const n of due) {
        if (n.at.getTime() > now.getTime() + this.graceMs) {
          continue;
        }
        const text = `📣 ${n.event.name}\n${n.event.message}`;
        try {
          await this.telegram.broadcast(text);
          await this.notifications.markDelivered(n.id);
        } catch (e) {
          this.logger.error(`Failed to send notification ${n.id}`, e as any);
        }
      }
      if (due.length > 0) {
        await this.notifications.cleanupEventsWithoutPending();
      }
    } catch (e) {
      this.logger.error('Notifications tick failed', e as any);
    } finally {
      this.busy = false;
    }
  }
}
