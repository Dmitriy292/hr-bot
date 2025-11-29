import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateQuestionDto } from './dto/create-question.dto';

export type QuestionModel = {
  id: number;
  question: string;
  answer: string;
  document: string | null;
  createdAt: Date;
};

type QMinimal = Pick<QuestionModel, 'id' | 'question' | 'answer' | 'document' | 'createdAt'>;

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/[\s\u00A0]+/g, ' ').trim();
}

function score(text: string, tokens: string[]): number {
  const t = ' ' + normalize(text) + ' ';
  let s = 0;
  for (const k of tokens) {
    const kk = normalize(k);
    if (!kk) continue;
    if (t.includes(' ' + kk + ' ')) s += 3; // whole word
    else if (t.includes(kk)) s += 1;       // substring
  }
  return s;
}

@Injectable()
export class QuestionsService {
  constructor(private prisma: PrismaService) {}

  async createQuestion(data: CreateQuestionDto): Promise<QuestionModel> {
    return this.prisma.question.create({ data });
  }

  async getQuestions(): Promise<QuestionModel[]> {
    return this.prisma.question.findMany({ orderBy: { id: 'asc' } });
  }

  async getQuestionById(id: number): Promise<QuestionModel | null> {
    return this.prisma.question.findUnique({ where: { id } });
  }

  async deleteQuestion(id: number): Promise<void> {
    await this.prisma.question.delete({ where: { id } });
  }

  /**
   * Поиск: возвращаем релевантные вопросы, отсортированные по убыванию score.
   *  - Используем только ключевые слова длиной >= 4 символов
   *  - Возвращаем топ по порогу: score >= max(3, bestScore-1), не более 15 результатов
   */
  async searchQuestion(keywords: string[]): Promise<QuestionModel[]> {
    const filtered = Array.from(
      new Set(keywords.map((k) => normalize(k)).filter((k) => k && k.length >= 4)),
    );
    if (filtered.length === 0) return [];
    const list: QMinimal[] = await this.prisma.question.findMany({
      select: { id: true, question: true, answer: true, document: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    if (list.length === 0) return [];

    const scored = list
      .map((q) => ({
        q,
        score: score(q.question + ' ' + (q.document || ''), filtered),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.q.id - b.q.id;
      });

    if (scored.length === 0) return [];
    const bestScore = scored[0].score;
    const threshold = Math.max(3, bestScore - 1);
    return scored
      .filter((s) => s.score >= threshold)
      .slice(0, 15)
      .map((s) => s.q as unknown as QuestionModel);
  }
}
