import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, session } from 'telegraf';
import axios from 'axios';
import { QuestionsService } from '../question/question.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscribersService } from '../subscribers/subscribers.service';

interface MySession {
  isAllowed?: boolean;
  waitingForSearch?: boolean;
  waitingForAddQuestion?: boolean;
  waitingForAddAnswer?: boolean;
  waitingForDeleteId?: boolean;
  waitingForExcel?: boolean;
  pendingQuestion?: string;
}

interface MyContext extends Context {
  session: MySession;
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<MyContext>;
  private allowedChatIds: string[];   // 👈 теперь как строки

  constructor(
    private readonly config: ConfigService,
    private readonly questions: QuestionsService,
    private readonly subscribers: SubscribersService,                  // 👈
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,
  ) {
    const token = this.config.get<string>('BOT_TOKEN');
    if (!token) throw new Error('BOT_TOKEN not set');
    this.bot = new Telegraf<MyContext>(token);

    const allowed = this.config.get<string>('ALLOWED_CHAT_IDS') || '';
    this.allowedChatIds = allowed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean); // строки, без Number(), чтобы не терять точность для -100...
  }

  async onModuleInit() {
    this.bot.use(session());

    // Middleware: маркер прав + авто-подписка
    this.bot.use(async (ctx, next) => {
      ctx.session = ctx.session || {};
      const chatIdStr = String(ctx.chat?.id ?? '');
      ctx.session.isAllowed = this.allowedChatIds.includes(chatIdStr);

      // каждый апдейт — сохраняем/обновляем подписчика
      if (chatIdStr) {
        try { await this.subscribers.add(chatIdStr); } catch {}
      }
      return next();
    });

    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        'Привет! Доступные команды:\n' +
          '/question — список Q&A\n' +
          '/searchquestion — найти ответ по ключевым словам\n' +
          '/add — добавить Q&A (для авторизованных)\n' +
          '/delete — удалить Q&A по ID (для авторизованных)\n' +
          '/upload — загрузить Excel с событиями (для авторизованных)\n' +
          '/myid — показать ваш Telegram ID',
      );
    });

    this.bot.command('myid', async (ctx) => {
      await ctx.reply(`Ваш Telegram ID: ${ctx.chat?.id}`);
    });

    // ==== Просмотр вопросов — доступно всем ====
    this.bot.command('question', async (ctx) => {
      try {
        const list = await this.questions.getQuestions();
        if (list.length === 0) return ctx.reply('Вопросы не найдены.');
        const msg = list.map((q) => `ID: ${q.id}\n${q.question}\n— ${q.answer}`).join('\n\n');
        await ctx.reply(msg);
      } catch {
        await ctx.reply('Ошибка при получении вопросов.');
      }
    });

    // ==== Поиск — доступно всем ====
    this.bot.command('searchquestion', async (ctx) => {
      const s = ctx.session;
      if (s.waitingForSearch || s.waitingForAddAnswer || s.waitingForAddQuestion || s.waitingForDeleteId || s.waitingForExcel) {
        return ctx.reply('Пожалуйста, завершите текущую операцию.');
      }
      s.waitingForSearch = true;
      await ctx.reply('Введи ключевые слова через пробел.');
    });

    // ==== Добавление — только ALLOWED ====
    this.bot.command('add', async (ctx) => {
      const s = ctx.session;
      if (!s.isAllowed) return ctx.reply('Ты не авторизован для добавления вопросов.');
      if (s.waitingForSearch || s.waitingForAddAnswer || s.waitingForAddQuestion || s.waitingForDeleteId || s.waitingForExcel) {
        return ctx.reply('Пожалуйста, завершите текущую операцию.');
      }
      s.waitingForAddQuestion = true;
      await ctx.reply('Отправь текст вопроса.');
    });

    // ==== Удаление — только ALLOWED ====
    this.bot.command('delete', async (ctx) => {
      const s = ctx.session;
      if (!s.isAllowed) return ctx.reply('Ты не авторизован для удаления вопросов.');
      if (s.waitingForSearch || s.waitingForAddAnswer || s.waitingForAddQuestion || s.waitingForDeleteId || s.waitingForExcel) {
        return ctx.reply('Пожалуйста, завершите текущую операцию.');
      }
      const list = await this.questions.getQuestions();
      if (list.length === 0) return ctx.reply('Вопросы не найдены.');
      const msg = list.map((q) => `ID: ${q.id}\n${q.question}\n— ${q.answer}`).join('\n\n');
      await ctx.reply(`Список вопросов:\n\n${msg}\n\nОтправь ID вопроса для удаления.`);
      s.waitingForDeleteId = true;
    });

    // ==== Загрузка Excel — только ALLOWED ====
    this.bot.command('upload', async (ctx) => {
      const s = ctx.session;
      if (!s.isAllowed) return ctx.reply('Ты не авторизован для загрузки Excel.');
      if (s.waitingForSearch || s.waitingForAddAnswer || s.waitingForAddQuestion || s.waitingForDeleteId || s.waitingForExcel) {
        return ctx.reply('Пожалуйста, завершите текущую операцию.');
      }
      s.waitingForExcel = true;
      await ctx.reply('Пришли Excel (.xlsx). Первая строка — заголовок, данные начинаются со второй.');
    });

    // Документ Excel (только ALLOWED, так как доступ в /upload ограничен выше)
    this.bot.on('document', async (ctx) => {
      const s = ctx.session;
      if (!s.waitingForExcel) return;
      s.waitingForExcel = false;

      const doc = ctx.message?.document;
      if (!doc) return;
      const fileName = doc.file_name || '';
      if (!fileName.toLowerCase().endsWith('.xlsx')) {
        return ctx.reply('Ожидался .xlsx файл.');
      }
      try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const response = await axios.get(link.href, { responseType: 'arraybuffer' });
        const arrBuf = response.data;
        const { events, notifications } = await this.notifications.ingestExcel(arrBuf);
        await ctx.reply(`Импорт завершен: событий ${events}, уведомлений ${notifications}.`);
      } catch {
        await ctx.reply('Не удалось обработать файл.');
      }
    });

    // Текстовые сообщения для процессов
    this.bot.on('text', async (ctx) => {
      const s = ctx.session;
      const text = (ctx.message as any)?.text?.trim() || '';
      if (!text) return;

      // Поиск — доступно всем
      if (s.waitingForSearch) {
        s.waitingForSearch = false;
        const keywords = text.split(' ').filter(Boolean);
        if (keywords.length === 0) return ctx.reply('Пожалуйста, введи хотя бы одно ключевое слово.');
        try {
          const data = await this.questions.searchQuestion(keywords);
          if (data && data.answer) {
            await ctx.reply(`Ответ: ${data.answer}`);
          } else {
            await ctx.reply('Ответ не найден.');
          }
        } catch {
          await ctx.reply('Ошибка при поиске.');
        }
        return;
      }

      // Добавление — только ALLOWED
      if (s.waitingForAddQuestion && s.isAllowed) {
        s.pendingQuestion = text;
        s.waitingForAddQuestion = false;
        s.waitingForAddAnswer = true;
        return ctx.reply('Теперь отправь ответ.');
      }
      if (s.waitingForAddAnswer && s.isAllowed) {
        const question = s.pendingQuestion || '';
        const answer = text;
        s.pendingQuestion = undefined;
        s.waitingForAddAnswer = false;
        try {
          await this.questions.createQuestion({ question, answer });
          await ctx.reply('Вопрос и ответ сохранены.');
        } catch {
          await ctx.reply('Ошибка при сохранении данных.');
        }
        return;
      }

      // Удаление — только ALLOWED
      if (s.waitingForDeleteId && s.isAllowed) {
        s.waitingForDeleteId = false;
        const id = Number(text);
        if (!Number.isInteger(id)) {
          return ctx.reply('Ожидался числовой ID.');
        }
        try {
          await this.questions.deleteQuestion(id);
          await ctx.reply(`Вопрос с ID ${id} удален.`);
        } catch {
          await ctx.reply('Ошибка при удалении.');
        }
        return;
      }

      await ctx.reply('Используй команды: /question /searchquestion /add /delete /upload /myid');
    });

    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Запуск бота' },
      { command: 'question', description: 'Список Q&A' },
      { command: 'searchquestion', description: 'Поиск ответа по ключевым словам' },
      { command: 'add', description: 'Добавить Q&A (для авторизованных)' },
      { command: 'delete', description: 'Удалить Q&A (для авторизованных)' },
      { command: 'upload', description: 'Загрузить Excel с событиями (для авторизованных)' },
      { command: 'myid', description: 'Показать ваш Telegram ID' },
    ]);

    await this.bot.launch();
    console.log('Telegram bot is running');
  }

  /** 👇 теперь рассылаем всем, кто писал боту (из таблицы Subscriber) */
  async broadcast(text: string) {
    const chatIds = await this.subscribers.allChatIds();
    for (const id of chatIds) {
      try {
        await this.bot.telegram.sendMessage(id as any, text); // строковый id безопасен для -100...
      } catch {}
    }
  }
}
