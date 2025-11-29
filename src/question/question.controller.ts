import { Controller, Get, Post, Body, Delete, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { QuestionsService, QuestionModel } from './question.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @UseGuards(ApiKeyGuard)
  @Post()
  async createQuestion(@Body() data: CreateQuestionDto): Promise<QuestionModel> {
    return this.questionsService.createQuestion(data);
  }

  // Защитили чтение списка тоже, хотя бот обращается к сервису напрямую
  @UseGuards(ApiKeyGuard)
  @Get()
  async getQuestions(): Promise<QuestionModel[]> {
    return this.questionsService.getQuestions();
  }

  @UseGuards(ApiKeyGuard)
  @Get('search')
  async searchQuestion(@Query('keywords') keywords: string): Promise<QuestionModel[]> {
    const arr = (keywords || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    return this.questionsService.searchQuestion(arr);
  }

  @UseGuards(ApiKeyGuard)
  @Delete(':id')
  async deleteQuestion(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.questionsService.deleteQuestion(id);
  }
}
