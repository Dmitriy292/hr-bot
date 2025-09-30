import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Question } from '@prisma/client';

type QMinimal = Pick<Question, 'id' | 'question' | 'answer' | 'document' | 'createdAt'>;
import { CreateQuestionDto } from './dto/create-question.dto';

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/[\s\u00A0]+/g, ' ').trim();
}

function score(text: string, tokens: string[]): number {
  const t = ' ' + normalize(text) + ' ';
  let s = 0;
  for (const k of tokens) {
    const kk = normalize(k);
    if (!kk) continue;
    // token presence
    if (t.includes(' ' + kk + ' ')) s += 3; // whole word
    else if (t.includes(kk)) s += 1;       // substring
  }
  return s;
}

@Injectable()
export class QuestionsService {
  constructor(private prisma: PrismaService) {}

  async createQuestion(data: CreateQuestionDto): Promise<Question> {
    return this.prisma.question.create({ data });
  }

  async getQuestions(): Promise<Question[]> {
    return this.prisma.question.findMany({ orderBy: { id: 'asc' } });
  }

  async deleteQuestion(id: number): Promise<void> {
    await this.prisma.question.delete({ where: { id } });
  }

  /**
   * SQLite-robust search:
   *  - fetch minimal fields
   *  - rank in memory to ensure correct case-insensitive match for any locale
   *  - pick the best by score (ties -> lowest id)
   */
  async searchQuestion(keywords: string[]): Promise<Question | null> {
    if (!keywords || keywords.length === 0) return null;
    const list: QMinimal[] = await this.prisma.question.findMany({
      select: { id: true, question: true, answer: true, document: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    if (list.length === 0) return null;

    let best: QMinimal | null = null;
    let bestScore = -1;
    for (const q of list) {
      const s = score(q.question + ' ' + (q.document || ''), keywords);
      if (s > bestScore || (s === bestScore && q.id < (best?.id ?? Number.MAX_SAFE_INTEGER))) {
        bestScore = s;
        best = q;
      }
    }
    if (bestScore <= 0) return null;
    return best as unknown as Question;
  }
}