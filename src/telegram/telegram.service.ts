import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, session, Markup } from 'telegraf';
import axios from 'axios';
import { QuestionsService } from '../question/question.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscribersService } from '../subscribers/subscribers.service';

interface MySession {
  isAllowed?: boolean;
  isAdmin?: boolean;
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

function resetSessionState(session: MySession) {
  session.waitingForSearch = false;
  session.waitingForAddQuestion = false;
  session.waitingForAddAnswer = false;
  session.waitingForDeleteId = false;
  session.waitingForExcel = false;
  session.pendingQuestion = undefined;
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightKeywords(text: string, keywords: string[]): string {
  let safe = escapeHtml(text || '');
  for (const k of keywords) {
    const norm = k.trim();
    if (!norm) continue;
    const re = new RegExp(escapeRegex(norm), 'gi');
    safe = safe.replace(re, (m) => `<b>${escapeHtml(m)}</b>`);
  }
  return safe;
}

const QUESTION_PAGE_SIZE = 20;
const DELETE_PAGE_SIZE = 10;

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: Telegraf<MyContext>;
  private allowedChatIds: string[];   // 👈 теперь как строки
  private adminChatIds: string[];

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

    const admin = this.config.get<string>('ADMIN_IDS') || allowed;
    this.adminChatIds = admin
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async onModuleInit() {
    this.bot.use(session());

    // Middleware: маркер прав + авто-подписка
    this.bot.use(async (ctx, next) => {
      ctx.session = ctx.session || {};
      const chatIdStr = String(ctx.chat?.id ?? '');
      ctx.session.isAdmin = this.adminChatIds.includes(chatIdStr);
      ctx.session.isAllowed = ctx.session.isAdmin || this.allowedChatIds.includes(chatIdStr);
      const incomingText = (ctx.message as any)?.text?.trim();
      if (incomingText && incomingText.startsWith('/') ) {
        resetSessionState(ctx.session);
      }

      // каждый апдейт — сохраняем/обновляем подписчика
      if (chatIdStr) {
        try { await this.subscribers.add(chatIdStr); } catch {}
      }
      return next();
    });

    const renderQuestionPage = (list: Awaited<ReturnType<typeof this.questions.getQuestions>>, page = 1) => {
      const totalPages = Math.max(1, Math.ceil(list.length / QUESTION_PAGE_SIZE));
      const safePage = Math.min(Math.max(page, 1), totalPages);
      const start = (safePage - 1) * QUESTION_PAGE_SIZE;
      const slice = list.slice(start, start + QUESTION_PAGE_SIZE);
      const lines = slice.map((q, idx) => `${start + idx + 1}. ${q.question}`);

      const rowSize = 5;
      const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
      for (let i = 0; i < slice.length; i += rowSize) {
        const row = slice.slice(i, i + rowSize).map((q, j) => {
          const num = start + i + j + 1;
          return Markup.button.callback(String(num), `question_${q.id}`);
        });
        buttons.push(row);
      }

      const nav: ReturnType<typeof Markup.button.callback>[] = [];
      if (safePage > 1) nav.push(Markup.button.callback('⬅️ Назад', `question_page_${safePage - 1}`));
      if (safePage < totalPages) nav.push(Markup.button.callback('Вперед ➡️', `question_page_${safePage + 1}`));
      if (nav.length) buttons.push(nav);

      const text = [`Страница ${safePage}/${totalPages}`, 'Выберите вопрос:', ...lines].join('\n');
      const keyboard = Markup.inlineKeyboard(buttons);
      return { text, keyboard };
    };

    const sendQuestionList = async (ctx: MyContext, page = 1, mode: 'reply' | 'edit' = 'reply') => {
      const list = await this.questions.getQuestions();
      if (list.length === 0) {
        if (mode === 'edit') {
          try { await ctx.editMessageText('Вопросы не найдены.'); return; } catch {}
        }
        await ctx.reply('Вопросы не найдены.');
        return;
      }
      const { text, keyboard } = renderQuestionPage(list, page);
      if (mode === 'edit') {
        try {
          await ctx.editMessageText(text, keyboard);
        } catch {
          await ctx.reply(text, keyboard);
        }
      } else {
        await ctx.reply(text, keyboard);
      }
    };

    const startSearch = async (ctx: MyContext) => {
      const s = ctx.session;
      resetSessionState(s);
      s.waitingForSearch = true;
      await ctx.reply('Введи ключевые слова через пробел.');
    };

    const startAdd = async (ctx: MyContext) => {
      const s = ctx.session;
      resetSessionState(s);
      if (!s.isAdmin) {
        await ctx.reply('Доступ запрещен.');
        return;
      }
      s.waitingForAddQuestion = true;
      await ctx.reply('Отправь текст вопроса.');
    };

    const renderDeletePage = (list: Awaited<ReturnType<typeof this.questions.getQuestions>>, page = 1) => {
      const totalPages = Math.max(1, Math.ceil(list.length / DELETE_PAGE_SIZE));
      const safePage = Math.min(Math.max(page, 1), totalPages);
      const start = (safePage - 1) * DELETE_PAGE_SIZE;
      const slice = list.slice(start, start + DELETE_PAGE_SIZE);

      const lines = slice.map((q) => {
        return [
          `ID: <b>${q.id}</b>`,
          `❓: ${escapeHtml(q.question)}`,
          '✅:',
          `<pre>${escapeHtml(q.answer)}</pre>`,
        ].join('\n');
      });

      const nav: ReturnType<typeof Markup.button.callback>[] = [];
      if (safePage > 1) nav.push(Markup.button.callback('⬅️', `delete_page_${safePage - 1}`));
      if (safePage < totalPages) nav.push(Markup.button.callback('➡️', `delete_page_${safePage + 1}`));
      const keyboard = nav.length ? Markup.inlineKeyboard([nav]) : undefined;

      const text = [
        `Страница ${safePage}/${totalPages}`,
        'Список вопросов:',
        ...lines,
        '<b><u>Отправь ID вопроса для удаления.</u></b>',
      ].join('\n\n');

      return { text, keyboard };
    };

    const startDelete = async (ctx: MyContext, page = 1, mode: 'reply' | 'edit' = 'reply', resetState = false) => {
      const s = ctx.session;
      if (resetState) {
        resetSessionState(s);
      }
      if (!s.isAdmin) {
        await ctx.reply('Доступ запрещен.');
        return;
      }
      const list = await this.questions.getQuestions();
      if (list.length === 0) {
        if (mode === 'edit') {
          try { await ctx.editMessageText('Вопросы не найдены.'); return; } catch {}
        }
        await ctx.reply('Вопросы не найдены.');
        return;
      }

      const { text, keyboard } = renderDeletePage(list, page);
      if (mode === 'edit') {
        try {
          await ctx.editMessageText(text, { ...keyboard, parse_mode: 'HTML' });
        } catch {
          await ctx.reply(text, { ...keyboard, parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(text, { ...keyboard, parse_mode: 'HTML' });
      }
      s.waitingForDeleteId = true;
    };

    const startUpload = async (ctx: MyContext) => {
      const s = ctx.session;
      resetSessionState(s);
      if (!s.isAdmin) {
        await ctx.reply('Доступ запрещен.');
        return;
      }
      s.waitingForExcel = true;
      await ctx.reply('Пришли Excel (.xlsx). Первая строка — заголовок, данные начинаются со второй.');
    };

    const runCommandShortcut = async (cmd: string, ctx: MyContext) => {
      switch (cmd) {
        case 'question':
          return sendQuestionList(ctx, 1, 'reply');
        case 'searchquestion':
          return startSearch(ctx);
        case 'add':
          return startAdd(ctx);
        case 'delete':
          return startDelete(ctx, 1, 'reply', true);
        case 'upload':
          return startUpload(ctx);
        case 'myid':
          return ctx.reply(`Ваш Telegram ID: ${ctx.chat?.id}`);
        default:
          return;
      }
    };

    this.bot.command('start', async (ctx) => {
      const isAdmin = !!ctx.session?.isAdmin;
      const baseCommands = [
        { cmd: 'question', desc: 'Список Q&A' },
        { cmd: 'searchquestion', desc: 'Поиск ответа' },
        { cmd: 'myid', desc: 'Показать ваш Telegram ID' },
      ];
      const adminCommands = [
        { cmd: 'add', desc: 'Добавить Q&A' },
        { cmd: 'delete', desc: 'Удалить Q&A' },
        { cmd: 'upload', desc: 'Загрузить Excel' },
      ];
      const commands = isAdmin ? [...baseCommands, ...adminCommands] : baseCommands;

      const textLines = [
        'Привет! Вот что я умею:',
        ...commands.map((c) => `/${c.cmd} — ${c.desc}`),
      ];

      const buttons = commands.map((c) => Markup.button.callback(`/${c.cmd}`, `cmd_${c.cmd}`));
      const keyboardRows: ReturnType<typeof Markup.button.callback>[][] = [];
      for (let i = 0; i < buttons.length; i += 2) {
        keyboardRows.push(buttons.slice(i, i + 2));
      }

      await ctx.reply(textLines.join('\n'), Markup.inlineKeyboard(keyboardRows));
    });

    this.bot.action(/cmd_(\w+)/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      const cmd = (ctx as any).match?.[1];
      if (!cmd) return;
      await runCommandShortcut(cmd, ctx as MyContext);
    });

    this.bot.command('myid', async (ctx) => {
      await ctx.reply(`Ваш Telegram ID: ${ctx.chat?.id}`);
    });

    // ==== Просмотр вопросов — inline список + пагинация ====
    this.bot.command('question', async (ctx) => {
      try {
        await sendQuestionList(ctx as MyContext, 1, 'reply');
      } catch {
        await ctx.reply('Ошибка при получении вопросов.');
      }
    });

    this.bot.action(/question_(\d+)/, async (ctx) => {
      try {
        const match = (ctx as any).match;
        const id = Number(match?.[1] ?? NaN);
        if (!Number.isInteger(id)) {
          await ctx.answerCbQuery('Некорректный запрос');
          return;
        }
        const item = await this.questions.getQuestionById(id);
        if (!item) {
          await ctx.answerCbQuery('Вопрос не найден', { show_alert: true });
          return;
        }
        await ctx.answerCbQuery();
        const back = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к списку', 'question_back')]]);
        await ctx.replyWithHTML(
          `<b>Вопрос:</b> ${escapeHtml(item.question)}\n<b>Ответ:</b> ${escapeHtml(item.answer)}`,
          back,
        );
      } catch {
        await ctx.answerCbQuery('Ошибка', { show_alert: true }).catch(() => {});
      }
    });

    this.bot.action('question_back', async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      await sendQuestionList(ctx as MyContext, 1, 'edit');
    });

    this.bot.action(/question_page_(\d+)/, async (ctx) => {
      const page = Number((ctx as any).match?.[1] ?? '1');
      await ctx.answerCbQuery().catch(() => {});
      await sendQuestionList(ctx as MyContext, page, 'edit');
    });

    this.bot.action(/delete_question_(\d+)/, async (ctx) => {
      const id = Number((ctx as any).match?.[1] ?? NaN);
      if (!Number.isInteger(id)) {
        await ctx.answerCbQuery('Некорректный ID', { show_alert: true }).catch(() => {});
        return;
      }
      if (!ctx.session?.isAdmin) {
        await ctx.answerCbQuery('Нет прав', { show_alert: true }).catch(() => {});
        return;
      }
      try {
        await this.questions.deleteQuestion(id);
        await ctx.answerCbQuery('Удалено').catch(() => {});
        await ctx.reply(`Вопрос с ID ${id} удален.`);
      } catch {
        await ctx.answerCbQuery('Ошибка удаления', { show_alert: true }).catch(() => {});
      }
    });

    this.bot.action(/delete_page_(\d+)/, async (ctx) => {
      const page = Number((ctx as any).match?.[1] ?? '1');
      await ctx.answerCbQuery().catch(() => {});
      await startDelete(ctx as MyContext, page, 'edit', false);
    });

    // ==== Поиск — доступно всем ====
    
    this.bot.command('searchquestion', async (ctx) => {
      await startSearch(ctx as MyContext);
    });


    // ==== Добавление — только ADMIN ====
    this.bot.command('add', async (ctx) => {
      await startAdd(ctx as MyContext);
    });

    // ==== Удаление — только ADMIN ====
    this.bot.command('delete', async (ctx) => {
      await startDelete(ctx as MyContext, 1, 'reply', true);
    });

    // ==== Загрузка Excel — только ADMIN ====
    this.bot.command('upload', async (ctx) => {
      await startUpload(ctx as MyContext);
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
    this.bot.on('text', async (ctx, next) => {
      const s = ctx.session;
      const text = (ctx.message as any)?.text?.trim() || '';
      if (!text) return next();

      // Поиск — доступно всем
      if (s.waitingForSearch) {
        s.waitingForSearch = false;
        const rawTokens = text
          .split(' ')
          .map((w: string) => w.trim())
          .filter((w: string) => !!w);
        const keywords = rawTokens.filter((w: string) => w.length >= 4);
        if (keywords.length === 0) return ctx.reply('Пожалуйста, введи хотя бы одно ключевое слово длиной от 4 символов.');
        try {
          const results = await this.questions.searchQuestion(keywords);
          if (results.length === 0) {
            await ctx.reply('Ответ не найден.');
            return;
          }
          for (const item of results) {
            const questionText = highlightKeywords(item.question || '—', rawTokens);
            const answerText = highlightKeywords(item.answer, rawTokens);
            const kb = s.isAdmin
              ? Markup.inlineKeyboard([
                  [Markup.button.callback('❌ Удалить этот вопрос', `delete_question_${item.id}`)],
                ])
              : undefined;
            await ctx.replyWithHTML(
              `<b>Вопрос:</b> ${questionText}\n<b>Ответ:</b> ${answerText}`,
              kb,
            );
          }
        } catch {
          await ctx.reply('Ошибка при поиске.');
        }
        return;
      }

      // Добавление — только ADMIN
      if (s.waitingForAddQuestion && s.isAdmin) {
        s.pendingQuestion = text;
        s.waitingForAddQuestion = false;
        s.waitingForAddAnswer = true;
        return ctx.reply('Теперь отправь ответ.');
      }
      if (s.waitingForAddAnswer && s.isAdmin) {
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

      // Удаление — только ADMIN
      if (s.waitingForDeleteId && s.isAdmin) {
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

      return next();
    });

    // Fallback для текста вне состояний
    this.bot.on('text', async (ctx) => {
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

  async broadcast(text: string) {
    const chatIds = await this.subscribers.allChatIds();
    for (const id of chatIds) {
      try {
        await this.bot.telegram.sendMessage(id as any, text); // строковый id безопасен для -100...
      } catch {}
    }
  }
}
